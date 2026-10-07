from pathlib import Path
import os, subprocess, tempfile, json, shutil, hashlib, base64, tarfile, io
workflow = (Path(__file__).resolve().parents[1] / 'workflows/release.yml').read_text()
start = workflow.index('          pr=$(gh pr list')
end = workflow.index('          gh workflow run ci.yml --ref changeset-release/main', start)
end += len('          gh workflow run ci.yml --ref changeset-release/main')
shell = 'set -euo pipefail\n' + '\n'.join(line[10:] for line in workflow[start:end].splitlines()) + '\n'
with tempfile.TemporaryDirectory(prefix='adapters-release-policy-') as directory:
    root = Path(directory)
    (root/'run.sh').write_text(shell)
    (root/'gh').write_text('''#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_LOG"
if [[ "$1 $2" == 'pr list' ]]; then
  count=0
  [[ ! -f "$MOCK_COUNT" ]] || count=$(cat "$MOCK_COUNT")
  count=$((count+1))
  printf '%s' "$count" > "$MOCK_COUNT"
  if [[ "$CASE" == existing || ( "$count" -gt 1 && ( "$CASE" == created || "$CASE" == denied_race ) ) ]]; then
    printf '6\\n'
  fi
elif [[ "$1 $2" == 'pr create' ]]; then
  if [[ "$CASE" == denied || "$CASE" == denied_race ]]; then
    echo 'pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)' >&2
    exit 1
  elif [[ "$CASE" == unrelated ]]; then
    echo 'GraphQL: Resource not accessible by integration' >&2
    exit 1
  fi
elif [[ "$1 $2" != 'workflow run' ]]; then
  exit 99
fi
''')
    (root/'git').write_text('''#!/usr/bin/env bash
[[ "$*" == 'rev-parse HEAD' ]] || exit 99
printf 'f58da4d2f5007c862bd49c851e9afe8cfd9065db\\n'
''')
    (root/'gh').chmod(0o755)
    (root/'git').chmod(0o755)
    for case in ['existing', 'created', 'denied', 'denied_race', 'unrelated', 'success_missing']:
        log, count, summary = (root/f'{case}.{suffix}' for suffix in ['log','count','summary'])
        env = dict(os.environ, PATH=f'{root}:'+os.environ['PATH'], CASE=case, MOCK_LOG=str(log), MOCK_COUNT=str(count), GITHUB_STEP_SUMMARY=str(summary), GITHUB_REPOSITORY='dal-go/dalgo-http-adapters')
        result = subprocess.run(['bash',str(root/'run.sh')],env=env,capture_output=True,text=True)
        should_pass = case not in ['unrelated','success_missing']
        assert (result.returncode == 0) == should_pass, (case,result.returncode,result.stderr)
        calls = log.read_text()
        assert ('workflow run ci.yml --ref changeset-release/main' in calls) == should_pass, (case,calls)
        assert summary.exists() == (case == 'denied'), (case,summary.exists())
        if case == 'denied':
            assert 'f58da4d2f5007c862bd49c851e9afe8cfd9065db' in summary.read_text()
            assert 'wb pr create' in summary.read_text()
        if case == 'existing':
            assert 'pr create' not in calls
        if case == 'unrelated':
            assert 'Resource not accessible by integration' in result.stderr
        print(f'PASS {case}: exit={result.returncode}, ci_dispatched={should_pass}, handoff={summary.exists()}')

# Execute the actual publishing shell against synthetic manifests and local mocks.
# No registry, tags, pushes, builds, credentials or BigQuery calls are used.
start = workflow.index('          source_sha=$(git rev-parse HEAD)')
end = workflow.index('          done', start) + len('          done')
# The metadata polling loop ends before the package loop.
end = workflow.index('          done', end) + len('          done')
shell = 'set -euo pipefail\n' + '\n'.join(line[10:] for line in workflow[start:end].splitlines()) + '\n'
sha = 'f58da4d2f5007c862bd49c851e9afe8cfd9065db'
with tempfile.TemporaryDirectory(prefix='adapters-release-selection-') as directory:
    root = Path(directory)
    (root/'run.sh').write_text(shell)
    (root/'git').write_text('''#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'rev-parse HEAD' ]]; then
  echo "$MOCK_SHA"
elif [[ "$1" == show ]]; then
  echo '{"version":"0.1.0"}'
elif [[ "$1" == config ]]; then
  :
elif [[ "$1" == fetch || "$1" == rev-parse ]]; then
  exit 1
elif [[ "$1" == tag || "$1" == push ]]; then
  printf 'git %s\\n' "$*" >> "$MOCK_LOG"
else
  exit 99
fi
''')
    (root/'npm').write_text('''#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == publish ]]; then
  if [[ "$2" == --access ]]; then
    printf 'publish %s\\n' "${PWD##*/}" >> "$MOCK_LOG"
  else
    [[ "$2" == "$BIGQUERY_ARTIFACT_DIR/dalgo-bigquery-0.2.0.tgz" ]] || exit 98
    [[ "$*" == *--ignore-scripts* ]] || exit 98
    printf 'publish bigquery\\n' >> "$MOCK_LOG"
  fi
  [[ "$CASE" != publish_error && "$CASE" != mixed_preceding_failure && "$CASE" != mixed_firestore_failure ]] || exit 1
elif [[ "$1" == view ]]; then
  [[ "$*" == *--registry=https://registry.npmjs.org* && "$*" == *--prefer-online* && "$*" == *--fetch-retries=0* && "$*" == *--fetch-timeout=10000* ]] || exit 98
  printf 'view\\n' >> "$MOCK_VIEW_LOG"
  attempts=$(wc -l < "$MOCK_VIEW_LOG")
  if [[ "$CASE" == metadata_pending || ( "$CASE" == metadata_delayed && "$attempts" -lt 25 ) ]]; then
    echo 'npm error code E404: version not found' >&2
    exit 1
  elif [[ "$CASE" == metadata_network ]]; then
    echo 'npm error code ECONNRESET' >&2
    exit 1
  elif [[ "$CASE" == metadata_auth ]]; then
    echo 'npm error code E401' >&2
    exit 1
  fi
  if [[ ! -f "$MOCK_SEEN" ]]; then
    touch "$MOCK_SEEN"
    exit 1
  fi
  name=${2%@*}
  version=${2##*@}
  reported_sha=$MOCK_SHA
  [[ "$CASE" != wrong_source && "$CASE" != mixed_preceding_wrong_source ]] || reported_sha=0000000000000000000000000000000000000000
  integrity=sha512-mock
  [[ "$CASE" != wrong_registry_integrity ]] || integrity=sha512-wrong
  if [[ "$CASE" == nested_registry_metadata ]]; then
    printf '{"name":"%s","version":"%s","gitHead":"%s","dist":{"integrity":"%s"}}\\n' "$name" "$version" "$reported_sha" "$integrity"
  elif [[ "$CASE" == conflicting_registry_metadata ]]; then
    printf '{"name":"%s","version":"%s","gitHead":"%s","dist.integrity":"sha512-wrong","dist":{"integrity":"sha512-mock"}}\\n' "$name" "$version" "$reported_sha"
  else
    printf '{"name":"%s","version":"%s","gitHead":"%s","dist.integrity":"%s"}\\n' "$name" "$version" "$reported_sha" "$integrity"
  fi
else
  exit 99
fi
''')
    (root/'curl').write_text('''#!/usr/bin/env bash
set -euo pipefail
while [[ "$1" != '--output' ]]; do shift; done
output=$2
touch "$MOCK_SEEN"
if [[ "$CASE" == registry_error ]]; then
  echo 'unavailable' > "$output"
  printf 503
elif [[ "$CASE" == registry_existing || "$CASE" == nested_registry_metadata || "$CASE" == conflicting_registry_metadata ]]; then
  echo '{}' > "$output"
  printf 200
else
  echo '"Not Found"' > "$output"
  printf 404
fi
''')
    (root/'node').write_text('''#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == .github/scripts/prepare-bigquery-release.mjs ]]; then
  printf 'artifact %s\\n' "$2" >> "$MOCK_LOG"
  if [[ "$2" == pack ]]; then
    [[ ! -d "$3" ]] || exit 98
    mkdir "$3"
    echo mock > "$3/dalgo-bigquery-0.2.0.tgz"
    printf '{"tarball":"%s/dalgo-bigquery-0.2.0.tgz","sha256":"mock","integrity":"sha512-mock"}' "$3" > "$3/packed-artifact.json"
    [[ "$CASE" != pack_error ]] || exit 1
  else
    [[ -f "$6" ]] || exit 98
    [[ "$CASE" != wrong_artifact && "$CASE" != wrong_core && "$CASE" != wrong_packed_githead ]] || exit 1
  fi
elif [[ "$1" == .github/scripts/check-bigquery-tarball.mjs ]]; then
  printf 'artifact check\\n' >> "$MOCK_LOG"
  [[ "$EXPECTED_SOURCE_SHA" == "$MOCK_SHA" && "$EXPECTED_PACKAGE_VERSION" == 0.2.0 ]] || exit 98
  [[ "$EXPECTED_ARTIFACT_SHA256" == mock && "$EXPECTED_ARTIFACT_INTEGRITY" == sha512-mock ]] || exit 98
  [[ "$4" == "$BIGQUERY_NODE20" && "$5" == "$(command -v node)" ]] || exit 98
  mkdir "$3"
  if [[ "$CASE" == checker_error ]]; then
    echo '{"partial":true}' > "$3/parity-0.json"
    echo 'partial fixture failure'
    exit 1
  fi
  echo '{}' > "$3/artifact-receipt.json"
  for report in parity-0 parity-1 http-0 http-1; do echo '{}' > "$3/$report.json"; done
else exit 99
fi
''')
    (root/'timeout').write_text('#!/usr/bin/env bash\n[[ "$1 $2 $3" == "--kill-after=2s 10s npm" ]] || exit 98\nshift 2\nexec "$@"\n')
    (root/'sleep').write_text('#!/usr/bin/env bash\necho sleep >> "$MOCK_SLEEP_LOG"\n')
    for executable in ['git', 'npm', 'curl', 'node', 'sleep', 'timeout']:
        (root/executable).chmod(0o755)
    for case in ['unchanged', 'bigquery_changed', 'publish_error', 'wrong_source', 'registry_error', 'registry_existing', 'mixed_preceding_failure', 'wrong_artifact', 'wrong_core', 'wrong_packed_githead', 'wrong_registry_integrity', 'pack_error', 'checker_error', 'firestore_changed', 'indexeddb_changed', 'mixed_firestore_failure', 'mixed_preceding_wrong_source', 'nested_registry_metadata', 'conflicting_registry_metadata', 'metadata_pending', 'metadata_delayed', 'metadata_network', 'metadata_auth']:
        log, seen = (root/f'{case}.{suffix}' for suffix in ['log','seen'])
        for package in ['firestore','indexeddb','bigquery']:
            manifest = root/'packages'/package/'package.json'
            manifest.parent.mkdir(parents=True,exist_ok=True)
            version = '0.2.0' if (package == 'bigquery' and case not in ['unchanged','firestore_changed','indexeddb_changed']) or (package == 'indexeddb' and case in ['mixed_preceding_failure','indexeddb_changed','mixed_preceding_wrong_source']) or (package == 'firestore' and case in ['firestore_changed','mixed_firestore_failure']) else '0.1.0'
            manifest.write_text('{"name":"@dalgo/'+package+'","version":"'+version+'"}')
        env=dict(os.environ,PATH=f'{root}:'+os.environ['PATH'],CASE=case,MOCK_LOG=str(log),MOCK_SEEN=str(seen),MOCK_SHA=sha,BIGQUERY_ARTIFACT_DIR=str(root/f'{case}.artifact'),BIGQUERY_CONSUMER_DIR=str(root/f'{case}.consumer'),BIGQUERY_NODE20=str(root/'node20'),MOCK_VIEW_LOG=str(root/f'{case}.views'),MOCK_SLEEP_LOG=str(root/f'{case}.sleeps'))
        result=subprocess.run(['bash',str(root/'run.sh')],cwd=root,env=env,capture_output=True,text=True)
        calls=log.read_text() if log.exists() else ''
        assert (result.returncode == 0) == (case in ['unchanged','bigquery_changed','registry_existing','firestore_changed','indexeddb_changed','metadata_delayed']), (case,result.stderr,calls)
        assert ('publish bigquery' in calls) == (case in ['bigquery_changed','publish_error','wrong_source','wrong_registry_integrity','metadata_pending','metadata_delayed','metadata_network','metadata_auth']), (case,calls)
        assert ('publish firestore' in calls) == (case in ['firestore_changed','mixed_firestore_failure']), (case,calls)
        assert ('publish indexeddb' in calls) == (case in ['mixed_preceding_failure','indexeddb_changed','mixed_preceding_wrong_source']), (case,calls)
        assert ('git push origin refs/tags/bigquery@v0.2.0' in calls) == (case in ['bigquery_changed','registry_existing','metadata_delayed']), (case,calls)
        assert calls.count('artifact pack') == (0 if case in ['unchanged','mixed_preceding_failure','mixed_firestore_failure','mixed_preceding_wrong_source','firestore_changed','indexeddb_changed'] else 1), (case,calls)
        assert calls.count('artifact check') == (0 if case in ['unchanged','mixed_preceding_failure','mixed_firestore_failure','mixed_preceding_wrong_source','pack_error','firestore_changed','indexeddb_changed'] else 1), (case,calls)
        if case.startswith('metadata_'):
            views = (root/f'{case}.views').read_text().splitlines()
            sleeps_path = root/f'{case}.sleeps'
            sleeps = sleeps_path.read_text().splitlines() if sleeps_path.exists() else []
            assert len(views) == {'metadata_pending':40,'metadata_network':40,'metadata_delayed':25,'metadata_auth':1}[case], (case,views)
            assert len(sleeps) == len(views)-1, (case,sleeps)
            assert calls.count('publish bigquery') == 1, (case,calls)
            assert 'npm publish succeeded' in result.stderr, (case,result.stderr)
            if case == 'metadata_pending':
                assert 'registry has not indexed this version' in result.stderr and 'release_sha='+sha in result.stderr
            if case == 'metadata_network':
                assert 'ECONNRESET' in result.stderr and 'indexing state is unknown' in result.stderr
            if case == 'metadata_auth':
                assert 'E401' in result.stderr and 'verification was denied' in result.stderr
        if case == 'publish_error':
            assert 'npm publish failed' in result.stderr
            assert not Path(env['MOCK_VIEW_LOG']).exists()
        if case == 'checker_error':
            artifacts = Path(env['BIGQUERY_ARTIFACT_DIR'])
            assert json.loads((artifacts/'parity-0.json').read_text()) == {'partial':True}
            assert 'partial fixture failure' in (artifacts/'check.log').read_text()
            assert not (artifacts/'tested-artifact.json').exists()
        print(f'PASS {case}: exit={result.returncode}, calls={calls.splitlines()}')
assert 'pnpm --filter @dalgo/bigquery check' in workflow

# Discriminate npm's selected-field output from a nested dist object: the old
# parser silently returns null for the genuine literal dotted key.
selected_metadata = json.dumps({'name':'@dalgo/bigquery','version':'0.2.0','gitHead':sha,'dist.integrity':'sha512-mock'})
literal = subprocess.run(['jq','-r','.["dist.integrity"]'],input=selected_metadata,capture_output=True,text=True,check=True).stdout.strip()
nested = subprocess.run(['jq','-r','.dist.integrity'],input=selected_metadata,capture_output=True,text=True,check=True).stdout.strip()
assert literal == 'sha512-mock' and nested == 'null', (literal,nested)
assert "jq -r '.[\"dist.integrity\"]'" in workflow
print('PASS npm selected-field integrity uses literal dotted key; nested parser yields null')

# The publish job must authorize an exact merged, same-repository version PR.
import json
start=workflow.index('          [[ "$SOURCE_SHA" =~')
end=workflow.index('\n      - uses: pnpm/action-setup', start)
shell='set -euo pipefail\n'+'\n'.join(line[10:] for line in workflow[start:end].splitlines())+'\n'
with tempfile.TemporaryDirectory(prefix='adapters-release-authorization-') as directory:
    root=Path(directory)
    (root/'run.sh').write_text(shell)
    (root/'git').write_text('''#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'rev-parse HEAD' ]]; then
  if [[ "$CASE" == wrong_checkout ]]; then echo 0000000000000000000000000000000000000000; else echo "$SOURCE_SHA"; fi
elif [[ "$1" == fetch ]]; then :
elif [[ "$1" == merge-base ]]; then [[ "$CASE" != off_main ]] || exit 1
else exit 99
fi
''')
    (root/'gh').write_text('#!/usr/bin/env bash\ncat "$MOCK_PRS"\n')
    (root/'git').chmod(0o755)
    (root/'gh').chmod(0o755)
    for case in ['merged', 'unmerged', 'wrong_sha', 'wrong_base', 'wrong_head', 'fork', 'duplicate', 'invalid_sha', 'wrong_checkout', 'off_main']:
        pr={'merged_at':'2026-10-06T10:00:00Z','merge_commit_sha':sha,'base':{'ref':'main'},'head':{'ref':'changeset-release/main','repo':{'full_name':'dal-go/dalgo-http-adapters'}}}
        if case == 'unmerged': pr['merged_at']=None
        if case == 'wrong_sha': pr['merge_commit_sha']='0'*40
        if case == 'wrong_base': pr['base']['ref']='other'
        if case == 'wrong_head': pr['head']['ref']='feature'
        if case == 'fork': pr['head']['repo']['full_name']='other/dalgo-http-adapters'
        prs=root/'prs.json'
        prs.write_text(json.dumps([pr,pr] if case == 'duplicate' else [pr]))
        env=dict(os.environ,PATH=f'{root}:'+os.environ['PATH'],CASE=case,SOURCE_SHA='not-a-sha' if case == 'invalid_sha' else sha,REPOSITORY='dal-go/dalgo-http-adapters',MOCK_PRS=str(prs))
        result=subprocess.run(['bash',str(root/'run.sh')],cwd=root,env=env,capture_output=True,text=True)
        assert (result.returncode == 0) == (case == 'merged'), (case,result.stderr)
        print(f'PASS authorization {case}: exit={result.returncode}')

# Manual recovery admits all public adapters, including BigQuery, only after
# exact registry identity, on-main source and matching source manifest checks.
tag_workflow = (Path(__file__).resolve().parents[1] / 'workflows/tag-published-package.yml').read_text()
start = tag_workflow.index('          set -euo pipefail')
end = tag_workflow.index('      - name: Create package tag', start)
shell = '\n'.join(line[10:] for line in tag_workflow[start:end].splitlines())
assert '          - bigquery\n' in tag_workflow
with tempfile.TemporaryDirectory(prefix='adapters-tag-recovery-') as directory:
    root = Path(directory)
    (root/'run.sh').write_text(shell)
    (root/'npm').write_text('''#!/usr/bin/env bash
set -euo pipefail
name="@dalgo/$PACKAGE"
version=$VERSION
source_sha=$MOCK_SHA
[[ "$CASE" != wrong_name ]] || name=@dalgo/other
[[ "$CASE" != wrong_version ]] || version=9.9.9
[[ "$CASE" != invalid_source ]] || source_sha=not-a-sha
printf '{"name":"%s","version":"%s","gitHead":"%s"}\\n' "$name" "$version" "$source_sha"
''')
    (root/'git').write_text('''#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == fetch || "$1" == cat-file ]]; then :
elif [[ "$1" == merge-base ]]; then [[ "$CASE" != off_main ]] || exit 1
elif [[ "$1" == show ]]; then
  version=$VERSION
  [[ "$CASE" != wrong_manifest ]] || version=9.9.9
  printf '{"name":"@dalgo/%s","version":"%s"}\\n' "$PACKAGE" "$version"
else exit 99
fi
''')
    (root/'npm').chmod(0o755)
    (root/'git').chmod(0o755)
    for case in ['firestore', 'indexeddb', 'bigquery', 'private_package', 'invalid_version', 'wrong_name', 'wrong_version', 'invalid_source', 'off_main', 'wrong_manifest']:
        output = root/f'{case}.output'
        package = case if case in ['firestore', 'indexeddb', 'bigquery'] else 'algolia' if case == 'private_package' else 'bigquery'
        env = dict(os.environ, PATH=f'{root}:'+os.environ['PATH'], CASE=case, PACKAGE=package, VERSION='v0.3.0' if case == 'invalid_version' else '0.3.0', MOCK_SHA=sha, GITHUB_OUTPUT=str(output))
        result = subprocess.run(['bash',str(root/'run.sh')],env=env,capture_output=True,text=True)
        succeeds = case in ['firestore', 'indexeddb', 'bigquery']
        assert (result.returncode == 0) == succeeds, (case, result.stderr)
        assert output.exists() == succeeds, case
        if succeeds: assert f'tag={package}@v0.3.0' in output.read_text()
        print(f'PASS tag recovery {case}: exit={result.returncode}')

# Exercise the real artifact helper with a local npm pack stand-in. The stand-in
# produces real tar bytes; publication/auth/network are never invoked.
node = shutil.which('node')
assert node, 'Node is required for artifact refusal tests'
repository = Path(__file__).resolve().parents[2]
core_integrity = 'sha512-mhEm1UrpPRHsJ+WbZ95cOxeZzpUioXxmmEa+FsI+FlVs0zFWKMqB/Sj/UkmQ7RSptbSM8OTFnXbQnowo5eTxCw=='
with tempfile.TemporaryDirectory(prefix='bigquery-pack-once-') as directory:
    root = Path(directory)
    repo = root/'repo'
    helper = repo/'.github/scripts/prepare-bigquery-release.mjs'
    helper.parent.mkdir(parents=True)
    shutil.copyfile(repository/'.github/scripts/prepare-bigquery-release.mjs', helper)
    pkg = repo/'packages/bigquery'
    (pkg/'dist').mkdir(parents=True)
    manifest = {'name':'@dalgo/bigquery','version':'0.2.0','peerDependencies':{'@dalgo/core':'^0.1.0'}, 'exports':{'.':{'import':'./dist/index.js','types':'./dist/index.d.ts'},'./analytical':{'import':'./dist/analytical.js','types':'./dist/analytical.d.ts'}}}
    (pkg/'package.json').write_text(json.dumps(manifest))
    for file in ['dist/index.js','dist/index.d.ts','dist/analytical.js','dist/analytical.d.ts','README.md','LICENSE']:
        (pkg/file).write_text('export {};')
    mock_bin = root/'bin'
    mock_bin.mkdir()
    # A Python executable on PATH replaces npm. It reads staging, emits a real
    # gzip archive and npm's pack JSON, and refuses every non-pack operation.
    mock_npm = mock_bin/'npm'
    mock_npm.write_text('#!'+shutil.which('python3')+'\n'+"""
import sys, os, json, tarfile, hashlib, base64
from pathlib import Path
assert sys.argv[1:4] == ['pack','--ignore-scripts','--json']
assert len(sys.argv) == 6 and sys.argv[4] == '--pack-destination'
with open(os.environ['PACK_LOG'],'a') as log: log.write('pack\\n')
manifest_path=Path('package.json')
manifest=json.loads(manifest_path.read_text())
case=os.environ['CASE']
if case == 'wrong_githead': manifest['gitHead']='0'*40
if case == 'wrong_version': manifest['version']='9.9.9'
if case == 'wrong_peer': manifest['peerDependencies']={'@dal-go/dalgo':'^0.1.0'}
manifest_path.write_text(json.dumps(manifest))
output=Path(sys.argv[5])/'dalgo-bigquery-0.2.0.tgz'
with tarfile.open(output,'w:gz') as tar:
    for file in sorted(Path('.').rglob('*')):
        if file.is_file(): tar.add(file,arcname='package/'+str(file))
integrity='sha512-'+base64.b64encode(hashlib.sha512(output.read_bytes()).digest()).decode()
if case == 'wrong_integrity': integrity='sha512-wrong'
print(json.dumps([{'filename':output.name,'integrity':integrity}]))
""")
    mock_npm.chmod(0o755)
    for case in ['good','wrong_githead','wrong_version','wrong_peer','wrong_integrity']:
        output=root/case
        log=root/(case+'.log')
        env=dict(os.environ,PATH=str(mock_bin)+':'+os.environ['PATH'],CASE=case,PACK_LOG=str(log))
        result=subprocess.run([node,str(helper),'pack',str(output),sha,'0.2.0'],env=env,capture_output=True,text=True)
        assert (result.returncode == 0) == (case == 'good'), (case,result.stderr)
        assert log.read_text().splitlines() == ['pack'], case
        assert json.loads((pkg/'package.json').read_text()) == manifest, 'tracked source mutated'
        print(f'PASS real helper pack {case}: exit={result.returncode}')
    output=root/'good'
    packed=json.loads((output/'packed-artifact.json').read_text())
    consumer={**packed,'core':{'version':'0.1.0','resolved':'https://registry.npmjs.org/@dalgo/core/-/core-0.1.0.tgz','integrity':core_integrity},'runtimes':[{'version':'v20.0.0'},{'version':'v24.15.0'}]}
    for case in ['good','wrong_sha256','wrong_sri','wrong_core','wrong_core_integrity','wrong_runtime','wrong_githead','wrong_artifact_path','wrong_bytes']:
        candidate=json.loads(json.dumps(consumer))
        if case == 'wrong_sha256': candidate['sha256']='0'*64
        if case == 'wrong_sri': candidate['integrity']='sha512-wrong'
        if case == 'wrong_core': candidate['core']['version']='0.2.0'
        if case == 'wrong_core_integrity': candidate['core']['integrity']='sha512-wrong'
        if case == 'wrong_runtime': candidate['runtimes'][0]['version']='v20.1.0'
        if case == 'wrong_githead': candidate['package']['gitHead']='0'*40
        if case == 'wrong_artifact_path': candidate['tarball']=str(root/'other.tgz')
        if case == 'wrong_bytes': Path(packed['tarball']).write_bytes(b'changed')
        receipt=root/(case+'.json')
        receipt.write_text(json.dumps(candidate))
        result=subprocess.run([node,str(helper),'verify',str(output),sha,'0.2.0',str(receipt)],env=env,capture_output=True,text=True)
        assert (result.returncode == 0) == (case == 'good'), (case,result.stderr)
        print(f'PASS real helper verify {case}: exit={result.returncode}')
    result=subprocess.run([node,str(helper),'pack',str(output),sha,'0.2.0'],env=env,capture_output=True,text=True)
    assert result.returncode != 0 and 'refusing a second pack' in result.stderr, result.stderr
    assert (root/'good.log').read_text().splitlines() == ['pack'], 'second npm pack called'
    print('PASS real helper refuses second pack')

publish_job = workflow.split('  publish:',1)[1]
assert "node-version: '20.0.0'" in publish_job
assert publish_job.index("node-version: '20.0.0'") < publish_job.index('node-version: 24') < publish_job.index('npm install --global npm@11.11.0')
assert 'if: always()' in publish_job and 'actions/upload-artifact@' in publish_job
assert 'path: ${{ runner.temp }}/bigquery-release' in publish_job

# Run the actual consumer checker against a synthetic installed tree. npm is a
# local stand-in that refuses publication and asserts strict installation flags.
# Runtime stand-ins do not claim real runtime execution; the release job must
# run the actual Node 20.0.0 and 24 binaries and production fixture tests.
with tempfile.TemporaryDirectory(prefix='bigquery-consumer-refusals-') as directory:
    root = Path(directory)
    mock_bin = root/'bin'
    mock_bin.mkdir()
    tarball = root/'dalgo-bigquery-0.2.0.tgz'
    manifest = json.loads((repository/'packages/bigquery/package.json').read_text())
    manifest['gitHead'] = sha
    with tarfile.open(tarball,'w:gz') as tar:
        files = {'package.json':json.dumps(manifest), 'README.md':'README', 'LICENSE':'MIT'}
        for entry in manifest['exports'].values():
            for target in entry.values(): files[target[2:]] = 'export {};'
        for name, source in files.items():
            data = source.encode()
            info = tarfile.TarInfo('package/'+name)
            info.size = len(data)
            tar.addfile(info,io.BytesIO(data))
    hashes = {'sha256':hashlib.sha256(tarball.read_bytes()).hexdigest(), 'integrity':'sha512-'+base64.b64encode(hashlib.sha512(tarball.read_bytes()).digest()).decode()}
    mock_npm = mock_bin/'npm'
    mock_npm.write_text('#!'+shutil.which('python3')+'\n'+"""
import sys, os, json, tarfile, hashlib, base64
from pathlib import Path
if sys.argv[1] == 'ls': sys.exit(0)
assert sys.argv[1] == 'install'
for flag in ['--strict-peer-deps','--legacy-peer-deps=false','--force=false','--ignore-scripts','--registry=https://registry.npmjs.org','--save-exact']: assert flag in sys.argv
assert '@dalgo/core@0.1.0' in sys.argv
assert not any(flag in sys.argv for flag in ['--legacy-peer-deps','--force','--no-strict-peer-deps'])
with open(os.environ['MOCK_LOG'],'a') as log: log.write('strict-install\\n')
case=os.environ['CASE']
if case == 'peer_failure': sys.exit(1)
tarball=next(Path(arg) for arg in sys.argv if arg.endswith('.tgz'))
package=Path('node_modules/@dalgo/bigquery')
package.mkdir(parents=True)
with tarfile.open(tarball) as tar:
    for file in tar.getmembers():
        target=package/file.name[len('package/'):]
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(tar.extractfile(file).read())
manifest=json.loads((package/'package.json').read_text())
if case == 'wrong_githead': manifest['gitHead']='0'*40
if case == 'wrong_version': manifest['version']='9.9.9'
if case == 'legacy_peer': manifest['peerDependencies']['@dal-go/dalgo']='^0.1.0'
(package/'package.json').write_text(json.dumps(manifest))
core={'version':'0.1.0','resolved':'https://registry.npmjs.org/@dalgo/core/-/core-0.1.0.tgz','integrity':os.environ['CORE_INTEGRITY']}
if case == 'wrong_core_version': core['version']='0.2.0'
if case == 'wrong_core_url': core['resolved']='file:/workspace/core'
if case == 'wrong_core_integrity': core['integrity']='sha512-wrong'
integrity='sha512-'+base64.b64encode(hashlib.sha512(tarball.read_bytes()).digest()).decode()
if case == 'wrong_installed_artifact': integrity='sha512-wrong'
packages={'node_modules/@dalgo/core':core,'node_modules/@dalgo/bigquery':{'integrity':integrity}}
if case == 'duplicate_core': packages['node_modules/other/node_modules/@dalgo/core']=core
if case == 'legacy_core': packages['node_modules/@dal-go/dalgo']=core
Path('package-lock.json').write_text(json.dumps({'packages':packages}))
tsc=Path('node_modules/typescript/bin/tsc')
tsc.parent.mkdir(parents=True)
tsc.write_text('process.exit(0);')
""")
    mock_npm.chmod(0o755)
    for major, version in [(20,'v20.0.0'),(24,'v24.15.0')]:
        runtime=mock_bin/f'node{major}'
        runtime.write_text('#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$1" == --version ]]; then echo '+version+'; else\n  echo runtime-'+str(major)+' >> "$MOCK_LOG"\n  if [[ "$CASE" == changed_during_tests ]]; then echo changed > "$MOCK_TARBALL"; fi\nfi\n')
        runtime.chmod(0o755)
    for case in ['good','wrong_core_version','wrong_core_url','wrong_core_integrity','duplicate_core','legacy_core','wrong_githead','wrong_version','legacy_peer','wrong_installed_artifact','peer_failure','changed_during_tests']:
        log=root/(case+'.log')
        env=dict(os.environ,PATH=str(mock_bin)+':'+os.environ['PATH'],CASE=case,MOCK_LOG=str(log),CORE_INTEGRITY=core_integrity,MOCK_TARBALL=str(tarball),EXPECTED_SOURCE_SHA=sha,EXPECTED_PACKAGE_VERSION=manifest['version'],EXPECTED_ARTIFACT_SHA256=hashes['sha256'],EXPECTED_ARTIFACT_INTEGRITY=hashes['integrity'])
        destination=root/(case+'.consumer')
        result=subprocess.run([node,str(repository/'.github/scripts/check-bigquery-tarball.mjs'),str(tarball),str(destination),str(mock_bin/'node20'),str(mock_bin/'node24')],env=env,capture_output=True,text=True)
        assert (result.returncode == 0) == (case == 'good'), (case,result.stderr)
        assert (destination/'artifact-receipt.json').exists() == (case == 'good'), case
        assert log.read_text().splitlines()[0] == 'strict-install', case
        if case == 'good':
            receipt=json.loads((destination/'artifact-receipt.json').read_text())
            assert receipt['package']['gitHead'] == sha and receipt['sha256'] == hashes['sha256'] and receipt['integrity'] == hashes['integrity']
            assert [runtime['version'] for runtime in receipt['runtimes']] == ['v20.0.0','v24.15.0']
            assert log.read_text().splitlines() == ['strict-install','runtime-20','runtime-24']
        print(f'PASS real checker {case}: exit={result.returncode}')
