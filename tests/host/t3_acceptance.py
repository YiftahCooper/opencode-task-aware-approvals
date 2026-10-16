"""Inspect/probe the explicitly authorized T3 test session; never execute a command.

Run outside the process sandbox so its app-owned server PID is visible. Auth is
read directly into memory and never printed or persisted. No sessions are created.
"""
import argparse
import base64
import json
from pathlib import Path
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--session', required=True)
parser.add_argument('--server', type=Path, help='Explicit T3 server metadata JSON path')
parser.add_argument('--probe', choices=['printf', 'publish'])
args = parser.parse_args()
metadata = [args.server] if args.server else list((Path.home() / '.t3/userdata/opencode-servers').glob('*.json'))
if len(metadata) != 1:
    raise RuntimeError('Select the test server explicitly; refusing ambiguous server state')
server = json.loads(metadata[0].read_text())
env = dict(x.split(b'=', 1) for x in (Path('/proc') / str(server['pid']) / 'environ').read_bytes().split(b'\0') if b'=' in x)
headers = {'Authorization': 'Basic ' + base64.b64encode(b'opencode:' + env[b'OPENCODE_PASSWORD']).decode()}
base = 'http://127.0.0.1:' + str(server['port'])
query = '?' + urllib.parse.urlencode({'location[directory]': str(Path.home())})

def request(path, body=None):
    req = urllib.request.Request(base + path + query, headers={**headers, 'Content-Type': 'application/json'}, data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=40) as response:
        return json.load(response)

session = request('/api/session/' + args.session)['data']
if session.get('title') != 'Task-aware approval acceptance' or session.get('parentID'):
    raise RuntimeError('Not the authorized ordinary T3 test session')
plugins = request('/api/plugin')['data']
output = {
    'sessionID': args.session,
    'outcome': session.get('outcome'),
    'permissions': session.get('permissions'),
    'approver': [{'id': x.get('id'), 'state': x.get('state')} for x in plugins if x.get('id') == 'opencode-task-aware-approvals'],
}
if args.probe:
    command = 'printf task-aware-approval-ok' if args.probe == 'printf' else 'git push origin HEAD'
    output['permissionProbe'] = request('/api/session/' + args.session + '/permission', {'action': 'shell', 'resources': [command], 'metadata': {'command': command}})['data']
print(json.dumps(output), flush=True)
