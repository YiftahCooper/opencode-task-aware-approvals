"""Read native profile binding without creating a session or model prompt.
Starts/stops its own native-profile server; installed plugins may start qualification.
This is not a zero-inference probe. Never prints credentials or provider data.
"""
import base64
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import selectors
import subprocess
import time
import urllib.parse
import urllib.request

source = Path(__file__).resolve().parents[2]
binary = Path.home() / '.opencode/bin/opencode'
version_text = subprocess.check_output([str(binary), '--version'], text=True).strip()
version = re.search(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version_text).group(0)
password = secrets.token_hex(24)
server = subprocess.Popen([str(binary), 'serve', '--hostname', '127.0.0.1', '--port', '0'], cwd=Path.home(), env={**os.environ, 'OPENCODE_PASSWORD': password, 'OPENCODE_DISABLE_MODELS_FETCH': 'true'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    selector = selectors.DefaultSelector(); selector.register(server.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + 30
    url = None
    while time.monotonic() < deadline and server.poll() is None:
        if not selector.select(.2): continue
        line = server.stdout.readline().decode(errors='replace')
        match = re.search(r'server listening on (http://127\.0\.0\.1:\d+)', line)
        if match: url = match.group(1); break
    if not url: raise RuntimeError('Native binding probe did not become ready')
    headers = {'Authorization': 'Basic ' + base64.b64encode(('opencode:' + password).encode()).decode()}
    query = urllib.parse.urlencode({'location[directory]': str(Path.home())})
    def get(path):
        with urllib.request.urlopen(urllib.request.Request(url + path + '?' + query, headers=headers), timeout=15) as r: return json.load(r)
    entries = get('/api/config')
    configs = [{'type': e.get('type'), 'path': e.get('path'), 'keys': sorted(e.get('info', {})), 'pluginCount': len(e.get('info', {}).get('plugins', e.get('info', {}).get('plugin', [])))} for e in entries]
    models = get('/api/model')['data']
    deadline = time.monotonic() + 10
    while True:
        plugins = get('/api/plugin')
        if any(name in json.dumps(plugins) for name in ('opencode-task-aware-approvals','opencode-auto-approval-plugin')) or time.monotonic() >= deadline: break
        time.sleep(.2)
    plugin_rows = plugins.get('data', plugins) if isinstance(plugins, dict) else plugins
    observed_plugins = [{'id': p.get('id'), 'status': p.get('state', {}).get('status'), 'isApprover': p.get('id') in ('opencode-task-aware-approvals','opencode-auto-approval-plugin')} for p in plugin_rows]
    models = get('/api/model')['data']
    provider = get('/api/provider/opencode-go')['data']
    # Use the exact qualification implementation for canonical hashes.
    result = subprocess.check_output(['node', str(source / 'tests/host/catalog-binding.mjs')], cwd=source, input=json.dumps({'models': models, 'provider': provider, 'hostVersion': version}).encode())
    output = json.loads(result)
    output['plugins'] = observed_plugins
    output['configSources'] = configs
    base = urllib.parse.urlsplit(provider.get('settings', {}).get('baseURL', ''))
    output['baseURL'] = urllib.parse.urlunsplit((base.scheme, base.hostname or '', base.path, '', ''))
    # Optional comparison against our own isolated qualification server, never
    # expose provider values (which can contain auth); report differing paths.
    if '--compare-qualification' in sys.argv:
        log = source.parent / '.backup-scratch/host/live/profile/server.log'
        if not log.is_file(): raise RuntimeError('Comparison unavailable: no isolated qualification server log')
        match = re.search(r'server listening on (http://127\.0\.0\.1:\d+)', log.read_text())
        if not match: raise RuntimeError('Comparison unavailable: no isolated qualification server address')
        q = urllib.parse.urlencode({'location[directory]': '/work/live/profile/project'})
        auth = 'Basic ' + base64.b64encode(b'opencode:synthetic-local-host-password').decode()
        req = urllib.request.Request(match.group(1) + '/api/provider/opencode-go?' + q, headers={'Authorization': auth})
        with urllib.request.urlopen(req, timeout=5) as response: isolated = json.load(response)['data']
        def differences(a, b, prefix=''):
            if isinstance(a, dict) and isinstance(b, dict):
                return [p for k in sorted(set(a) | set(b)) for p in differences(a.get(k), b.get(k), prefix + '.' + k)]
            return [prefix] if a != b else []
        output['providerDifferentPaths'] = differences(provider, isolated)
        output['nativeIntegration'] = provider.get('integrationID')
        output['isolatedIntegration'] = isolated.get('integrationID')
        output['nativeProviderSetting'] = provider.get('settings', {}).get('provider')
        output['isolatedProviderSetting'] = isolated.get('settings', {}).get('provider')
        output['nativeHeaderNames'] = sorted(provider.get('headers', {}))
        output['isolatedHeaderNames'] = sorted(isolated.get('headers', {}))
    if '--write-binding' in sys.argv:
        target = source.parent / 'qualification/native-binding.json'
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        target.write_text(json.dumps(output)); target.chmod(0o600)
    if '--export-catalog' in sys.argv:
        # Extract only this public record, never the credentials or session DB.
        database = Path.home() / '.local/share/opencode/opencode.db'
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
            row = connection.execute('SELECT value FROM kv WHERE key = ?', ('models-dev:catalog',)).fetchone()
        if not row:
            raise RuntimeError('Native public model catalog record is unavailable')
        body = json.loads(json.loads(row[0])['body'])
        if not isinstance(body, dict) or 'opencode-go' not in body:
            raise RuntimeError('Unexpected public model catalog schema')
        target = source.parent / '.backup-scratch/native-models.json'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(body)); target.chmod(0o600)
        output['publicCatalogExported'] = True
    print(json.dumps(output), flush=True)
finally:
    server.terminate()
    try: server.wait(timeout=5)
    except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=5)
