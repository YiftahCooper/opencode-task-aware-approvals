"""Offline helpers shared by the isolated live harness and its synthetic checks."""
import json
import re

def latest_results(results):
    return list({r['candidate']['key']: r for r in results}.values())

def selected_protocol(root):
    build=json.loads((root/'dist/build.json').read_text())['build']
    if not re.fullmatch('[a-f0-9]{64}',build):
        raise ValueError('Invalid selected build identity')
    return 'task-aware-v1:'+build

def completed(state_directory, state, stopping=False):
    # The state mutex is deliberately short; only the batch lease covers inference.
    # When policy has been disabled, wait for its current invocation and lease to
    # finish. Pending work/reserved spend remains intact for a future resume.
    return not any((state_directory/'batch-locks').glob('claim-*.json')) and (stopping or not state.get('batch'))

def current_results(state, protocol, native_keys):
    return [r for r in latest_results(state['results']) if r['protocol']==protocol and r['candidate']['key'] in native_keys]
