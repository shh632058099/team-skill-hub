#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT=""; CONFIG_HOME=""; HUB_BASE_URL=""; SERVER_NAME="teamSkillHub"; API_KEY_ENV="TEAM_SKILL_HUB_API_KEY"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --client) CLIENT="${2:-}"; shift 2 ;;
    --config-home) CONFIG_HOME="${2:-}"; shift 2 ;;
    --hub-base-url) HUB_BASE_URL="${2:-}"; shift 2 ;;
    --server-name) SERVER_NAME="${2:-}"; shift 2 ;;
    --api-key-env) API_KEY_ENV="${2:-}"; shift 2 ;;
    *) echo "Unknown bootstrap option: $1" >&2; exit 2 ;;
  esac
done
[[ "$CLIENT" == "codex" || "$CLIENT" == "claude" ]] || { echo "bootstrap client must be codex or claude" >&2; exit 2; }
[[ -n "$CONFIG_HOME" && -n "$HUB_BASE_URL" ]] || { echo "bootstrap config home and Hub base URL are required" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is required by Team Skill Hub client runtime" >&2; exit 2; }
REMOTE_TMP=""
cleanup_remote(){ if [[ -n "$REMOTE_TMP" ]]; then rm -rf "$REMOTE_TMP"; fi; return 0; }
trap cleanup_remote EXIT
if [[ -f "$SCRIPT_DIR/../client-integration/release.json" ]]; then
  PACKAGE_ROOT="$(cd "$SCRIPT_DIR/../client-integration" && pwd)"
  PACKAGE_SCRIPTS="$SCRIPT_DIR"
elif [[ -f "$SCRIPT_DIR/../release.json" ]]; then
  PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  PACKAGE_SCRIPTS="$PACKAGE_ROOT/scripts"
else
  REMOTE_TMP="$(mktemp -d)"
  mkdir -p "$REMOTE_TMP/package"
  export HUB_BASE_URL REMOTE_TMP
  node <<'NODE'
const fs=require('fs'),crypto=require('crypto'),path=require('path');
(async()=>{const base=process.env.HUB_BASE_URL.replace(/\/$/,'');const manifestUrl=base+'/client-integration/manifest.json';const mr=await fetch(manifestUrl);if(!mr.ok)throw new Error(`manifest HTTP ${mr.status}`);const manifest=await mr.json();const pkg=manifest.packages?.linux;if(!pkg?.path||!pkg?.sha256)throw new Error('manifest has no Linux client package');const url=new URL(pkg.path,manifestUrl).href;const r=await fetch(url);if(!r.ok)throw new Error(`package HTTP ${r.status}`);const buf=Buffer.from(await r.arrayBuffer());const actual=crypto.createHash('sha256').update(buf).digest('hex');if(actual!==String(pkg.sha256).toLowerCase())throw new Error('client package SHA-256 mismatch');fs.writeFileSync(path.join(process.env.REMOTE_TMP,'linux.tar.gz'),buf)})().catch(e=>{console.error(`Failed to download Team Skill Hub client package: ${e.message}`);process.exit(1)});
NODE
  tar -xzf "$REMOTE_TMP/linux.tar.gz" -C "$REMOTE_TMP/package"
  PACKAGE_ROOT="$REMOTE_TMP/package"
  PACKAGE_SCRIPTS="$PACKAGE_ROOT/scripts"
fi
ROOT="${TEAM_SKILL_HUB_CLIENT_ROOT:-$HOME/.team-skill-hub}"
mkdir -p "$CONFIG_HOME" "$ROOT/bin" "$ROOT/releases" "$ROOT/cache" "$ROOT/locks" "$ROOT/transactions"
CONFIG_HOME="$(cd "$CONFIG_HOME" && pwd -P)"
export PACKAGE_ROOT PACKAGE_SCRIPTS ROOT CLIENT CONFIG_HOME HUB_BASE_URL SERVER_NAME API_KEY_ENV
if command -v python3 >/dev/null 2>&1; then
python3 <<'PY'
import json, os, pathlib, shutil
pkg=pathlib.Path(os.environ['PACKAGE_ROOT']); root=pathlib.Path(os.environ['ROOT']); state_path=root/'state.json'
release=json.loads((pkg/'release.json').read_text(encoding='utf-8')); version=int(release['version'])
state={}
if state_path.exists():
    try: state=json.loads(state_path.read_text(encoding='utf-8'))
    except Exception as e: raise SystemExit(f'Existing Team Skill Hub state.json is invalid: {e}')
hub=os.environ['HUB_BASE_URL'].rstrip('/')
old=state.get('hub_base_url')
if old and old.rstrip('/') != hub:
    raise SystemExit(f'Existing client integration points to a different Team Skill Hub: {old} != {hub}')
installed=state.get('installed_version')
if isinstance(installed,int) and installed > version:
    raise SystemExit(f'A newer Team Skill Hub client integration v{installed} is already installed; refusing downgrade to v{version}')
release_dir=root/'releases'/f'v{version}'; tmp=root/'releases'/f'v{version}.bootstrap-tmp'
if tmp.exists(): shutil.rmtree(tmp)
tmp.mkdir(parents=True)
for name in ('runtime','updater','templates'):
    src=pkg/name
    if src.exists(): shutil.copytree(src,tmp/name)
scripts=pathlib.Path(os.environ['PACKAGE_SCRIPTS'])
if scripts.exists(): shutil.copytree(scripts,tmp/'scripts')
shutil.copy2(pkg/'release.json',tmp/'release.json')
if release_dir.exists(): shutil.rmtree(release_dir)
tmp.rename(release_dir)
for name in ('team-skill-hub-client','team-skill-hub-client.ps1'):
    src=pkg/'runtime'/name
    if src.exists(): shutil.copy2(src,root/'bin'/name)
clients=state.get('clients') or {}
clients[os.environ['CLIENT']]={'enabled':True,'config_home':os.environ['CONFIG_HOME'],'server_name':os.environ['SERVER_NAME']}
new={**state,'schema_version':1,'installed_version':version,'hub_base_url':hub,'api_key_env':os.environ['API_KEY_ENV'],'clients':clients}
tmp_state=state_path.with_suffix('.json.tmp'); tmp_state.write_text(json.dumps(new,ensure_ascii=False,indent=2)+'\n',encoding='utf-8'); tmp_state.replace(state_path)
(root/'current').write_text(str(version)+'\n',encoding='utf-8')
PY
else
node <<'NODE'
const fs=require('fs'),path=require('path');const pkg=process.env.PACKAGE_ROOT,root=process.env.ROOT,statePath=path.join(root,'state.json');const release=JSON.parse(fs.readFileSync(path.join(pkg,'release.json'),'utf8')),version=Number(release.version);let state={};if(fs.existsSync(statePath))state=JSON.parse(fs.readFileSync(statePath,'utf8'));const hub=process.env.HUB_BASE_URL.replace(/\/$/,'');if(state.hub_base_url&&state.hub_base_url.replace(/\/$/,'')!==hub)throw new Error(`Existing client integration points to a different Team Skill Hub: ${state.hub_base_url} != ${hub}`);if(Number.isInteger(state.installed_version)&&state.installed_version>version)throw new Error(`A newer Team Skill Hub client integration v${state.installed_version} is already installed; refusing downgrade to v${version}`);const target=path.join(root,'releases',`v${version}`);fs.rmSync(target,{recursive:true,force:true});fs.mkdirSync(target,{recursive:true});for(const n of ['runtime','updater','templates'])if(fs.existsSync(path.join(pkg,n)))fs.cpSync(path.join(pkg,n),path.join(target,n),{recursive:true});if(fs.existsSync(process.env.PACKAGE_SCRIPTS))fs.cpSync(process.env.PACKAGE_SCRIPTS,path.join(target,'scripts'),{recursive:true});fs.copyFileSync(path.join(pkg,'release.json'),path.join(target,'release.json'));for(const n of ['team-skill-hub-client','team-skill-hub-client.ps1'])if(fs.existsSync(path.join(pkg,'runtime',n)))fs.copyFileSync(path.join(pkg,'runtime',n),path.join(root,'bin',n));state={...state,schema_version:1,installed_version:version,hub_base_url:hub,api_key_env:process.env.API_KEY_ENV,clients:{...(state.clients||{}),[process.env.CLIENT]:{enabled:true,config_home:process.env.CONFIG_HOME,server_name:process.env.SERVER_NAME}}};fs.writeFileSync(statePath+'.tmp',JSON.stringify(state,null,2)+'\n');fs.renameSync(statePath+'.tmp',statePath);fs.writeFileSync(path.join(root,'current'),String(version)+'\n');
NODE
fi
chmod +x "$ROOT/bin/team-skill-hub-client" 2>/dev/null || true