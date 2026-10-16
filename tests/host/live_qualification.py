"""Bounded real Go qualification. Use only the documented isolated command.
Credentials are mounted read-only; all provider runtime data stays on tmpfs.
Only synthetic operations are sent to reviewers. No proposed command executes.
"""
import json
import os
import subprocess
from pathlib import Path
import sys
import time
import urllib.parse
from reference_harness import launch_host
from test_plugin import request, configure, activate
from live_acceptance import run_acceptance
from qualification_helpers import latest_results, selected_protocol, completed, current_results

root = Path('/work/live')
root.mkdir(parents=True, exist_ok=True)
data = Path('/tmp/live-data/opencode'); data.mkdir(parents=True, exist_ok=True)
(data / 'auth.json').symlink_to('/auth.json')
cache = Path('/tmp/live-cache/opencode'); cache.mkdir(parents=True, exist_ok=True)
(cache / 'models.json').symlink_to('/models.json')
fixture = launch_host.__wrapped__(root)
launch = next(fixture)
key = json.loads(Path('/auth.json').read_text())['opencode-go']['key']
key_values = [key]
extra = {'XDG_DATA_HOME': '/tmp/live-data', 'XDG_CACHE_HOME': '/tmp/live-cache', 'XDG_STATE_HOME': '/tmp/live-state', 'OPENCODE_DISABLE_MODELS_FETCH': 'true', 'OPENCODE_MODELS_PATH': '/models.json'}
native_binding = json.loads(Path('/evidence/native-binding.json').read_text())
base_config = {}
def start(config):
    return launch('v2', '/opencode', {}, global_config={**base_config, **config}, profile='profile', extra_env=extra)
try:
    host = start({})
    # Reuse the existing key through native Go integration, not the Zen env fallback.
    # This credential copy exists only in the isolated tmpfs database.
    request(host, '/api/credential', {'integrationID': 'opencode-go', 'label': 'Existing Go key (isolated qualification)', 'value': {'type': 'key', 'key': key}, 'activate': True})
    query = urllib.parse.urlencode({'location[directory]': str(host['project'])})
    request(host, '/api/config?' + query)
    deadline = time.monotonic() + 15
    while True:
        try:
            configure(host)
            catalog = request(host, '/api/model?' + query)['data']
            relevant = [m for m in catalog if m['providerID'] == 'opencode-go' and m['id'].startswith(('gpt-', 'claude-'))]
            if relevant: break
        except Exception: pass
        if time.monotonic() > deadline: raise RuntimeError('Authenticated Go catalog unavailable')
        time.sleep(.2)
    print('Go candidates:', ', '.join(m['id'] for m in relevant), flush=True)
    time.sleep(.5)
    provider = configure(host)
    binding = json.loads(subprocess.check_output(['/node', '--import', '/plugin/node_modules/tsx/dist/loader.mjs', '/plugin/tests/host/catalog-binding.mjs'], input=json.dumps({'provider': provider, 'models': catalog, 'hostVersion': native_binding['hostVersion']}).encode()))
    if binding['providerFingerprint'] != native_binding['providerFingerprint'] or {c['modelID']: c['key'] for c in binding['candidates']} != {c['modelID']: c['key'] for c in native_binding['candidates']}:
        print(json.dumps({'bindingMismatch': binding}), flush=True)
        raise RuntimeError('Native binding mismatch before inference; qualification not started')
    if '--preflight' in sys.argv:
        state_file = Path('/evidence/selection.json')
        state = json.loads(state_file.read_text()) if state_file.exists() else {'spend': []}
        print(json.dumps({'preflight': 'passed', 'reservedCalls': len(state['spend']), 'inferenceCallsMade': 0, **binding}), flush=True)
        if '--hold-preflight' in sys.argv: time.sleep(30)
        raise SystemExit(0)
    qualification_trusted = (host['root'] / 'home/.config/opencode/task-aware-approvals.json').read_text()
    host['stop']()
    if '--diagnostic' in sys.argv:
        state_dir=root / 'profile/home/.local/state/opencode/task-aware-approvals'
        subprocess.run(['/node','--import','/plugin/node_modules/tsx/dist/loader.mjs','/plugin/tests/host/reserve-diagnostic.mjs',str(state_dir)],check=True)
        host=start({'plugin':[['/plugin/tests/host/diagnostic',{}]]})
        query=urllib.parse.urlencode({'location[directory]':str(host['project'])})
        request(host,'/api/plugin?'+query)
        for _ in range(35):
            log=(host['root']/'server.log').read_text()
            if 'DIAGNOSTIC ' in log:
                print(next(line for line in log.splitlines() if line.startswith('DIAGNOSTIC ')),flush=True)
                break
            time.sleep(1)
        else: print('Diagnostic did not complete within its bounded window',flush=True)
        raise SystemExit(0)
    host = start({'plugin': [[os.environ.get('TASK_AWARE_PLUGIN_PATH', '/plugin'), {}]]})
    activate(host)
    state_file = host['root'] / 'home/.local/state/opencode/task-aware-approvals/selection.json'
    if '--acceptance' in sys.argv:
        state = json.loads(state_file.read_text())
        selected = next((r for r in latest_results(state['results']) if r['candidate']['key'] == state.get('incumbent')), None)
        if not selected or selected['candidate']['key'] not in {c['key'] for c in native_binding['candidates']}:
            raise RuntimeError('A current native-qualified reviewer is required for live acceptance')
        results = run_acceptance(host, selected)
        evidence = Path('/evidence/acceptance.json')
        evidence.write_text(json.dumps({'model': selected['candidate']['modelID'], 'protocol': selected['protocol'], 'candidateKey': selected['candidate']['key'], 'providerFingerprint': native_binding['providerFingerprint'], 'cases': results}))
        evidence.chmod(0o600)
        raise SystemExit(0)
    deadline = time.monotonic() + 21 * 60
    previous = None
    stopping = False
    native_keys = {c['key'] for c in native_binding['candidates']}
    protocol = selected_protocol(Path(os.environ.get('TASK_AWARE_PLUGIN_PATH', '/plugin')))
    while time.monotonic() < deadline:
        if state_file.exists():
            state = json.loads(state_file.read_text())
            progress = (len(state['spend']), len(state['results']), state['status'])
            if progress != previous:
                print(json.dumps({'calls': progress[0], 'completedCandidates': progress[1], 'status': progress[2]}), flush=True); previous = progress
            if state.get('cooldownUntil', 0) > time.time() * 1000:
                raise RuntimeError('Provider cooldown active; live tests remain pending')
            current = current_results(state, protocol, native_keys)
            if '--stop-after-first-pass' in sys.argv and state.get('incumbent') in {r['candidate']['key'] for r in current} and not stopping:
                policy_path = host['root'] / 'home/.config/opencode/task-aware-approvals.json'
                policy = json.loads(qualification_trusted); policy['enabled'] = False
                policy_path.write_text(json.dumps(policy)); policy_path.chmod(0o600)
                stopping = True
            if current and completed(state_file.parent, state, stopping=stopping):
                print(json.dumps({'results': state['results'], 'incumbent': state.get('incumbent')}), flush=True)
                if not state.get('incumbent'): raise RuntimeError('No real model qualified; approval stays manual')
                # State is already bound to the durable qualification directory.
                # Retain its provider binding there, never credentials/transcripts.
                accepted = Path('/evidence')
                trusted = accepted / 'trusted.json'
                trusted.write_text(qualification_trusted)
                trusted.chmod(0o600)
                print('Durable qualification evidence ready for installation', flush=True)
                break
        time.sleep(1)
    else: raise RuntimeError('Qualification deadline exceeded')
except Exception as error:
    # Do not print API responses or provider runtime state containing credentials.
    print(type(error).__name__ + ': ' + str(error)[:120], file=sys.stderr, flush=True)
    raise SystemExit(1)
finally:
    try: next(fixture)
    except StopIteration: pass
