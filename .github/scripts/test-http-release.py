"""Local immutable artifact guard regressions; no registry/provider requests."""
from pathlib import Path
import json, os, shutil, subprocess, tempfile
repo = Path(__file__).resolve().parents[2]
node = shutil.which('node')
assert node
with tempfile.TemporaryDirectory(prefix='http-artifact-guards-') as directory:
    root = Path(directory)
    sandbox = root/'repository'
    helper = sandbox/'.github/scripts/prepare-http-release.mjs'
    helper.parent.mkdir(parents=True)
    shutil.copyfile(repo/'.github/scripts/prepare-http-release.mjs', helper)
    package = sandbox/'packages/http'
    package.mkdir(parents=True)
    manifest = json.loads((repo/'packages/http/package.json').read_text())
    manifest['gitHead'] = 'a'*40
    (package/'dist').mkdir()
    (package/'dist/index.js').write_text('export const fixture = true;')
    (package/'dist/index.d.ts').write_text('export declare const fixture: boolean;')
    for name in ['README.md', 'LICENSE']:
        shutil.copyfile(repo/'packages/http'/name, package/name)
    env = dict(os.environ, NPM_CONFIG_CACHE=str(root/'npm-cache'))
    for case in ['valid', 'private', 'wrong_access', 'git_peer', 'wrong_name', 'missing_license']:
        changed = json.loads(json.dumps(manifest))
        if case == 'private': changed['private'] = True
        if case == 'wrong_access': changed['publishConfig']['access'] = 'restricted'
        if case == 'git_peer': changed['peerDependencies']['@dalgo/core'] = 'github:dal-go/dalgo-js#main'
        if case == 'wrong_name': changed['name'] = '@dalgo/http'
        (package/'package.json').write_text(json.dumps(changed))
        if case == 'missing_license': (package/'LICENSE').unlink()
        artifact = root/case
        result = subprocess.run([node, str(helper), 'pack', str(artifact), 'a'*40, manifest['version']], env=env, capture_output=True, text=True)
        assert (result.returncode == 0) == (case == 'valid'), (case, result.stderr)
        print('PASS pack', case)
    artifact = root/'valid'
    original = json.loads((artifact/'packed-artifact.json').read_text())
    consumer = dict(original, core={'version':'0.6.0', 'resolved':'https://registry.npmjs.org/@dalgo/core/-/core-0.6.0.tgz', 'integrity':'sha512-C/hoawh4YU5Htm9PnrQi7Z9gP9rsy2PZ3Aj9RU3sV+76mEPHQ2rKWGkBjaxSoHB4PZn4DLpAzqQ+OoMKfzZ8BQ=='}, browser={'synthetic':True, 'providerRequests':0, 'blockedExternalRequests':[], 'core':'registry:0.6.0'})
    receipt = root/'tested.json'
    for case in ['valid', 'changed_integrity', 'wrong_source', 'git_core', 'wrong_core', 'provider_request', 'missing_browser']:
        changed = json.loads(json.dumps(consumer))
        if case == 'changed_integrity': changed['integrity'] = 'sha512-wrong'
        if case == 'wrong_source': changed['sourceSHA'] = 'b'*40
        if case == 'git_core': changed['core']['resolved'] = 'https://codeload.github.com/core'
        if case == 'wrong_core': changed['core']['version'] = '0.4.0'
        if case == 'provider_request': changed['browser']['providerRequests'] = 1
        if case == 'missing_browser': changed.pop('browser')
        receipt.write_text(json.dumps(changed))
        result = subprocess.run([node, str(helper), 'verify', str(artifact), 'a'*40, manifest['version'], str(receipt)], env=env, capture_output=True, text=True)
        assert (result.returncode == 0) == (case == 'valid'), (case, result.stderr)
        print('PASS verify', case)
    result = subprocess.run([node, str(helper), 'pack', str(artifact), 'a'*40, manifest['version']], env=env, capture_output=True, text=True)
    assert result.returncode != 0 and 'refusing a second pack' in result.stderr
    print('PASS second-pack refusal')
