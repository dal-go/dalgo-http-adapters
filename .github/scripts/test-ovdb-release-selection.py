"""Exercise the exact OVDB publishing shell with authored fixtures and local mocks."""
from pathlib import Path
import json, os, subprocess, tempfile
repo = Path(__file__).resolve().parents[2]
workflow = (repo/'.github/workflows/release.yml').read_text()
start = workflow.index('          source_sha=$(git rev-parse HEAD)')
end = workflow.index('          done', start) + len('          done')
end = workflow.index('          done', end) + len('          done')
shell = 'set -euo pipefail\n' + '\n'.join(line[10:] for line in workflow[start:end].splitlines()) + '\n'
shell = shell.replace('for package in firestore indexeddb bigquery http ovdb; do', 'for package in "$SELECTED"; do')
sha = 'a'*40
with tempfile.TemporaryDirectory(prefix='ovdb-release-selection-') as directory:
    root = Path(directory)
    (root/'run.sh').write_text(shell)
    scripts = {
      'git': '''#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'rev-parse HEAD' ]]; then echo "$MOCK_SHA"
elif [[ "$1" == show ]]; then echo '{"version":"0.1.0"}'
elif [[ "$1" == config ]]; then :
elif [[ "$1" == fetch || "$1" == rev-parse ]]; then exit 1
elif [[ "$1" == tag || "$1" == push ]]; then echo "$*" >> "$MOCK_LOG"
else exit 99; fi
''',
      'node': '''#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == .github/scripts/prepare-ovdb-release.mjs || "$1" == .github/scripts/check-ovdb-tarball.mjs ]] || exit 99
if [[ "$1" == *check-* ]]; then
  echo check >> "$MOCK_LOG"
  [[ "$EXPECTED_SOURCE_SHA" == "$MOCK_SHA" && "$EXPECTED_PACKAGE_VERSION" == 0.2.0 && "$EXPECTED_ARTIFACT_SHA256" == mock && "$EXPECTED_ARTIFACT_INTEGRITY" == sha512-mock ]] || exit 98
  [[ "$4" == "$OVDB_NODE20" ]] || exit 98
  [[ "$CASE" != checker_failure ]] || exit 1
  mkdir "$3"; echo '{}' > "$3/artifact-receipt.json"
else
  echo "$2" >> "$MOCK_LOG"
  if [[ "$2" == pack ]]; then
    mkdir "$3"; echo synthetic > "$3/dalgo-ovdb-0.2.0.tgz"
    printf '{"tarball":"%s/dalgo-ovdb-0.2.0.tgz","sha256":"mock","integrity":"sha512-mock"}' "$3" > "$3/packed-artifact.json"
  else [[ -f "$6" ]] || exit 98; fi
fi
''',
      'curl': '''#!/usr/bin/env bash
set -euo pipefail
while [[ "$1" != --output ]]; do shift; done
if [[ "$CASE" == network ]]; then exit 7; fi
if [[ "$CASE" == existing || "$CASE" == wrong_integrity || "$CASE" == wrong_sha || "$CASE" == wrong_registry_name || "$CASE" == wrong_registry_version ]]; then echo '{}' > "$2"; echo -n 200
elif [[ "$CASE" == auth401 ]]; then echo '{}' > "$2"; echo -n 401
elif [[ "$CASE" == auth403 ]]; then echo '{}' > "$2"; echo -n 403
elif [[ "$CASE" == unavailable ]]; then echo '{}' > "$2"; echo -n 503
elif [[ "$CASE" == malformed404 ]]; then echo '{}' > "$2"; echo -n 404
else echo '"Not Found"' > "$2"; echo -n 404; fi
''',
      'npm': '''#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == publish ]]; then
  [[ "$2" == "$OVDB_ARTIFACT_DIR/dalgo-ovdb-0.2.0.tgz" && "$*" == *--ignore-scripts* && "$*" == *--provenance* ]] || exit 98
  echo publish >> "$MOCK_LOG"
  [[ "$CASE" != bootstrap_auth ]] || exit 1
elif [[ "$1" == view ]]; then
  name=@dalgo/ovdb; version=0.2.0; integrity=sha512-mock; source=$MOCK_SHA
  [[ "$CASE" != wrong_integrity ]] || integrity=wrong
  [[ "$CASE" != wrong_sha ]] || source=wrong
  [[ "$CASE" != wrong_registry_name ]] || name=@dalgo/wrong
  [[ "$CASE" != wrong_registry_version ]] || version=9.9.9
  printf '{"name":"%s","version":"%s","gitHead":"%s","dist.integrity":"%s"}' "$name" "$version" "$source" "$integrity"
else exit 99; fi
''',
      'timeout': '#!/usr/bin/env bash\nshift 2\nexec "$@"\n',
    }
    for name, body in scripts.items():
        (root/name).write_text(body); (root/name).chmod(0o755)
    cases = ['unchanged', 'new404', 'existing', 'wrong_name', 'unknown', 'malformed404', 'auth401', 'auth403', 'unavailable', 'network', 'checker_failure', 'wrong_integrity', 'wrong_sha', 'wrong_registry_name', 'wrong_registry_version', 'bootstrap_auth']
    for case in cases:
        selected = 'unknown' if case == 'unknown' else 'ovdb'
        manifest = root/'packages'/selected/'package.json'; manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({'name':'@dal-go/dalgo2ovdb' if case == 'wrong_name' else '@dalgo/ovdb', 'version':'0.1.0' if case == 'unchanged' else '0.2.0'}))
        log = root/(case+'.log')
        env = dict(os.environ, PATH=str(root)+':'+os.environ['PATH'], CASE=case, SELECTED=selected, MOCK_SHA=sha, MOCK_LOG=str(log), OVDB_NODE20=str(root/'node20'), BIGQUERY_ARTIFACT_DIR=str(root/'unrelated-bigquery'), HTTP_ARTIFACT_DIR=str(root/'unrelated-http'), OVDB_ARTIFACT_DIR=str(root/(case+'.artifact')), OVDB_CONSUMER_DIR=str(root/(case+'.consumer')))
        result = subprocess.run(['bash', str(root/'run.sh')], cwd=root, env=env, capture_output=True, text=True)
        calls = log.read_text().splitlines() if log.exists() else []
        succeeds = case in ['unchanged', 'new404', 'existing']
        assert (result.returncode == 0) == succeeds, (case, calls, result.stderr)
        assert ('publish' in calls) == (case in ['new404', 'bootstrap_auth']), (case, calls)
        assert any('push origin refs/tags/ovdb@v0.2.0' in call for call in calls) == (case in ['new404', 'existing']), (case, calls)
        if case not in ['unchanged', 'wrong_name', 'unknown']: assert calls.count('pack') == 1, (case, calls)
        if case == 'unchanged': assert calls == [], calls
        print('PASS OVDB selection', case)

# Exercise real Changesets in a fresh authored workspace, without repository edits.
with tempfile.TemporaryDirectory(prefix='ovdb-changesets-') as directory:
    root = Path(directory); (root/'.changeset').mkdir()
    (root/'package.json').write_text(json.dumps({'name':'synthetic-workspace','private':True,'workspaces':['packages/*']}))
    (root/'pnpm-workspace.yaml').write_text('packages:\n  - packages/*\n')
    config = json.loads((repo/'.changeset/config.json').read_text()); config['changelog'] = False
    (root/'.changeset/config.json').write_text(json.dumps(config))
    (root/'.changeset/ovdb.md').write_text((repo/'.changeset/ovdb-completed-dtql.md').read_text())
    for package, name in [('ovdb','@dalgo/ovdb'),('unrelated','@dalgo/unrelated')]:
        p=root/'packages'/package; p.mkdir(parents=True)
        (p/'package.json').write_text(json.dumps({'name':name,'version':'0.1.0','private':False}))
    result = subprocess.run(['node',str(repo/'node_modules/@changesets/cli/bin.js'),'version'],cwd=root,capture_output=True,text=True)
    assert result.returncode == 0, result.stderr
    assert json.loads((root/'packages/ovdb/package.json').read_text())['version'] == '0.2.0'
    assert json.loads((root/'packages/unrelated/package.json').read_text())['version'] == '0.1.0'
    assert not (root/'.changeset/ovdb.md').exists()
    print('PASS ordinary public 0.1.0 minor Changesets generation to 0.2.0')
