from pathlib import Path
import os, subprocess, tempfile
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
  printf 'publish %s\\n' "${PWD##*/}" >> "$MOCK_LOG"
  [[ "$CASE" != publish_error ]] || exit 1
elif [[ "$1" == view ]]; then
  if [[ ! -f "$MOCK_SEEN" ]]; then
    touch "$MOCK_SEEN"
    exit 1
  fi
  name=${2%@*}
  version=${2##*@}
  reported_sha=$MOCK_SHA
  [[ "$CASE" != wrong_source ]] || reported_sha=0000000000000000000000000000000000000000
  printf '{"name":"%s","version":"%s","gitHead":"%s"}\\n' "$name" "$version" "$reported_sha"
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
elif [[ "$CASE" == registry_existing ]]; then
  echo '{}' > "$output"
  printf 200
else
  echo '"Not Found"' > "$output"
  printf 404
fi
''')
    (root/'git').chmod(0o755)
    (root/'npm').chmod(0o755)
    (root/'curl').chmod(0o755)
    for case in ['unchanged', 'bigquery_changed', 'publish_error', 'wrong_source', 'registry_error', 'registry_existing']:
        log, seen = (root/f'{case}.{suffix}' for suffix in ['log','seen'])
        for package in ['firestore','indexeddb','bigquery']:
            manifest = root/'packages'/package/'package.json'
            manifest.parent.mkdir(parents=True,exist_ok=True)
            version = '0.2.0' if package == 'bigquery' and case != 'unchanged' else '0.1.0'
            manifest.write_text('{"name":"@dalgo/'+package+'","version":"'+version+'"}')
        env=dict(os.environ,PATH=f'{root}:'+os.environ['PATH'],CASE=case,MOCK_LOG=str(log),MOCK_SEEN=str(seen),MOCK_SHA=sha)
        result=subprocess.run(['bash',str(root/'run.sh')],cwd=root,env=env,capture_output=True,text=True)
        calls=log.read_text() if log.exists() else ''
        assert (result.returncode == 0) == (case in ['unchanged','bigquery_changed','registry_existing']), (case,result.stderr,calls)
        assert ('publish bigquery' in calls) == (case not in ['unchanged','registry_error','registry_existing']), (case,calls)
        assert 'publish firestore' not in calls and 'publish indexeddb' not in calls, (case,calls)
        assert ('git push origin refs/tags/bigquery@v0.2.0' in calls) == (case in ['bigquery_changed','registry_existing']), (case,calls)
        print(f'PASS {case}: exit={result.returncode}, calls={calls.splitlines()}')
assert 'pnpm --filter @dalgo/bigquery check' in workflow

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
