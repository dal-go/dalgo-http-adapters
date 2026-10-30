"""Local immutable artifact guard regressions; no registry/provider requests."""
from pathlib import Path
import json, os, shutil, subprocess, tempfile
repo = Path(__file__).resolve().parents[2]
node = shutil.which('node')
assert node
with tempfile.TemporaryDirectory(prefix='ovdb-artifact-guards-') as directory:
    root = Path(directory)
    sandbox = root/'repository'
    helper = sandbox/'.github/scripts/prepare-ovdb-release.mjs'
    helper.parent.mkdir(parents=True)
    shutil.copyfile(repo/'.github/scripts/prepare-ovdb-release.mjs', helper)
    shutil.copyfile(repo/'.github/scripts/ovdb-release-cores.mjs', helper.parent/'ovdb-release-cores.mjs')
    package = sandbox/'packages/ovdb'
    package.mkdir(parents=True)
    manifest = json.loads((repo/'packages/ovdb/package.json').read_text())
    manifest['gitHead'] = 'a'*40
    (package/'dist-tugql').mkdir()
    (package/'dist-tugql/index.js').write_text('export const fixture = true;')
    (package/'dist-tugql/index.d.ts').write_text('export declare const fixture: boolean;')
    for name in ['README.md', 'LICENSE']:
        shutil.copyfile(repo/'packages/ovdb'/name, package/name)
    env = dict(os.environ, NPM_CONFIG_CACHE=str(root/'npm-cache'))
    for case in ['valid', 'old_peer', 'near_widened_peer', 'core_dependency', 'core_optional_peer', 'private', 'wrong_access', 'git_peer', 'wrong_name', 'missing_license', 'legacy_output', 'extra_export']:
        changed = json.loads(json.dumps(manifest))
        if case == 'private': changed['private'] = True
        if case == 'wrong_access': changed['publishConfig']['access'] = 'restricted'
        if case == 'git_peer': changed['peerDependencies']['@dalgo/core'] = 'github:dal-go/dalgo-js#main'
        if case == 'near_widened_peer': changed['peerDependencies']['@dalgo/core'] = '>=0.6.0 <0.8.0'
        if case == 'old_peer': changed['peerDependencies']['@dalgo/core'] = '>=0.6.0 <0.7.0'
        if case == 'core_dependency': changed['dependencies']['@dalgo/core'] = '^0.6.0'
        if case == 'core_optional_peer': changed['peerDependenciesMeta'] = {'@dalgo/core': {'optional': True}}
        if case == 'wrong_name': changed['name'] = '@dal-go/dalgo2ovdb'
        if case == 'legacy_output': (package/'dist-tugql/legacy.js').write_text('export class OpenVaultDbClient {}')
        if case == 'extra_export': changed['exports']['./legacy'] = changed['exports']['.']
        (package/'package.json').write_text(json.dumps(changed))
        if case == 'missing_license': (package/'LICENSE').unlink()
        artifact = root/case
        result = subprocess.run([node, str(helper), 'pack', str(artifact), 'a'*40, manifest['version']], env=env, capture_output=True, text=True)
        assert (result.returncode == 0) == (case == 'valid'), (case, result.stderr)
        if case == 'legacy_output': (package/'dist-tugql/legacy.js').unlink()
        print('PASS OVDB pack', case)
    artifact = root/'valid'
    original = json.loads((artifact/'packed-artifact.json').read_text())
    consumer = dict(original, core={'version':'0.6.0', 'resolved':'https://registry.npmjs.org/@dalgo/core/-/core-0.6.0.tgz', 'integrity':'sha512-C/hoawh4YU5Htm9PnrQi7Z9gP9rsy2PZ3Aj9RU3sV+76mEPHQ2rKWGkBjaxSoHB4PZn4DLpAzqQ+OoMKfzZ8BQ=='}, browser={'synthetic':True, 'providerRequests':0, 'blockedExternalRequests':[], 'core':'registry:0.6.0', 'defaultNativeFetch':True, 'nativeDefaultPosts':2, 'nativeDefaultRows':2, 'explicitNativeFetch':True, 'nativeExplicitPosts':2, 'nativeExplicitRows':2})
    consumer['runtimes'] = [dict(nodeVersion=f'v{major}.0.0', synthetic=True, typedImports=True, nativeRows=1, preIORefusal=True, providerRequests=0, core='registry:0.6.0', package=original['package'], sourceSHA=original['sourceSHA'], sha256=original['sha256'], integrity=original['integrity']) for major in [20,24]]
    consumer['coreMatrix'] = [json.loads(json.dumps(consumer))]
    for version, integrity in [('0.8.0', 'sha512-k2xNCvWBhQUlk9Vhrt1rEsEAemv4nOlZyCl/AXou/Plr05b+d6kOIeG7rfb0fz46fwr/rMKjQyHG7GuSEZFF3A=='), ('0.8.1', 'sha512-stXi8PPeR3G7AxCairfJEMDGd4KuiU5eyipPDgibCEVlRD435t2FvfQQj3mp+FgZEVzcdel4Z4Iwq3xm9URRSA==')]:
        proof = json.loads(json.dumps(consumer['coreMatrix'][0]))
        proof['core'] = dict(version=version, resolved=f'https://registry.npmjs.org/@dalgo/core/-/core-{version}.tgz', integrity=integrity)
        proof['browser']['core'] = f'registry:{version}'
        for runtime in proof['runtimes']: runtime['core'] = f'registry:{version}'
        consumer['coreMatrix'].append(proof)
    receipt = root/'tested.json'
    for case in ['valid', 'changed_integrity', 'wrong_source', 'git_core', 'wrong_core', 'provider_request', 'missing_browser', 'missing_native_fetch', 'wrong_native_posts', 'wrong_native_rows', 'missing_explicit_fetch', 'wrong_explicit_posts', 'wrong_explicit_rows', 'missing_runtime', 'wrong_runtime', 'wrong_runtime24', 'wrong_runtime20_patch', 'swapped_runtimes', 'one_runtime', 'duplicate_runtime', 'wrong_runtime_artifact', 'wrong_runtime_source', 'missing_typed_import', 'missing_runtime_refusal', 'missing_matrix', 'missing_core08', 'missing_core081', 'swapped_matrix', 'modern_git_core', 'modern_wrong_integrity', 'modern_wrong_artifact', 'modern_provider_request', 'modern_missing_typed_import', 'consumer081_wrong_integrity', 'consumer081_missing_browser', 'consumer081_missing_runtime']:
        changed = json.loads(json.dumps(consumer))
        if case == 'changed_integrity': changed['integrity'] = 'sha512-wrong'
        if case == 'wrong_source': changed['sourceSHA'] = 'b'*40
        if case == 'git_core': changed['core']['resolved'] = 'https://codeload.github.com/core'
        if case == 'wrong_core': changed['core']['version'] = '0.4.0'
        if case == 'provider_request': changed['browser']['providerRequests'] = 1
        if case == 'missing_browser': changed.pop('browser')
        if case == 'missing_native_fetch': changed['browser'].pop('defaultNativeFetch')
        if case == 'wrong_native_posts': changed['browser']['nativeDefaultPosts'] = 0
        if case == 'wrong_native_rows': changed['browser']['nativeDefaultRows'] = 1
        if case == 'missing_explicit_fetch': changed['browser'].pop('explicitNativeFetch')
        if case == 'wrong_explicit_posts': changed['browser']['nativeExplicitPosts'] = 0
        if case == 'wrong_explicit_rows': changed['browser']['nativeExplicitRows'] = 1
        if case == 'missing_runtime': changed.pop('runtimes')
        if case == 'wrong_runtime': changed['runtimes'][0]['nodeVersion'] = 'v22.0.0'
        if case == 'wrong_runtime20_patch': changed['runtimes'][0]['nodeVersion'] = 'v20.1.0'
        if case == 'wrong_runtime24': changed['runtimes'][1]['nodeVersion'] = 'v22.0.0'
        if case == 'swapped_runtimes': changed['runtimes'].reverse()
        if case == 'one_runtime': changed['runtimes'].pop()
        if case == 'duplicate_runtime': changed['runtimes'][1]['nodeVersion'] = 'v20.0.0'
        if case == 'wrong_runtime_artifact': changed['runtimes'][0]['integrity'] = 'sha512-wrong'
        if case == 'wrong_runtime_source': changed['runtimes'][0]['sourceSHA'] = 'b'*40
        if case == 'missing_typed_import': changed['runtimes'][0]['typedImports'] = False
        if case == 'missing_runtime_refusal': changed['runtimes'][0]['preIORefusal'] = False
        if case == 'missing_matrix': changed.pop('coreMatrix')
        if case == 'missing_core08': changed['coreMatrix'].pop(1)
        if case == 'missing_core081': changed['coreMatrix'].pop(2)
        if case == 'swapped_matrix': changed['coreMatrix'].reverse()
        if case == 'modern_git_core': changed['coreMatrix'][1]['core']['resolved'] = 'https://codeload.github.com/core'
        if case == 'modern_wrong_integrity': changed['coreMatrix'][1]['core']['integrity'] = 'sha512-wrong'
        if case == 'modern_wrong_artifact': changed['coreMatrix'][1]['integrity'] = 'sha512-wrong'
        if case == 'modern_provider_request': changed['coreMatrix'][1]['browser']['providerRequests'] = 1
        if case == 'modern_missing_typed_import': changed['coreMatrix'][1]['runtimes'][0]['typedImports'] = False
        if case == 'consumer081_wrong_integrity': changed['coreMatrix'][2]['core']['integrity'] = 'sha512-wrong'
        if case == 'consumer081_missing_browser': changed['coreMatrix'][2].pop('browser')
        if case == 'consumer081_missing_runtime': changed['coreMatrix'][2]['runtimes'].pop()
        receipt.write_text(json.dumps(changed))
        result = subprocess.run([node, str(helper), 'verify', str(artifact), 'a'*40, manifest['version'], str(receipt)], env=env, capture_output=True, text=True)
        assert (result.returncode == 0) == (case == 'valid'), (case, result.stderr)
        print('PASS verify', case)
    result = subprocess.run([node, str(helper), 'pack', str(artifact), 'a'*40, manifest['version']], env=env, capture_output=True, text=True)
    assert result.returncode != 0 and 'refusing a second pack' in result.stderr
    print('PASS second-pack refusal')
