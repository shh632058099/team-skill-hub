param(
  [Parameter(Mandatory=$true)][ValidateSet('codex','claude')][string]$Client,
  [Parameter(Mandatory=$true)][string]$ConfigHome,
  [Parameter(Mandatory=$true)][string]$HubBaseUrl,
  [string]$ServerName='teamSkillHub',
  [string]$ApiKeyEnv='TEAM_SKILL_HUB_API_KEY'
)
$ErrorActionPreference='Stop'
if(-not (Get-Command node -ErrorAction SilentlyContinue)){throw 'node is required by Team Skill Hub client runtime'}
$RepoPackage=Join-Path $PSScriptRoot '..\client-integration'
$ArchivePackage=Join-Path $PSScriptRoot '..'
if(Test-Path (Join-Path $RepoPackage 'release.json')){$PackageRoot=$RepoPackage;$PackageScripts=$PSScriptRoot}elseif(Test-Path (Join-Path $ArchivePackage 'release.json')){$PackageRoot=$ArchivePackage;$PackageScripts=Join-Path $ArchivePackage 'scripts'}else{throw 'client integration release.json not found'}
$PackageRoot=(Resolve-Path $PackageRoot).Path
$PackageScripts=(Resolve-Path $PackageScripts).Path
$Root=if($env:TEAM_SKILL_HUB_CLIENT_ROOT){$env:TEAM_SKILL_HUB_CLIENT_ROOT}else{Join-Path $HOME '.team-skill-hub'}
New-Item -ItemType Directory -Force -Path $ConfigHome,$Root,(Join-Path $Root 'bin'),(Join-Path $Root 'releases'),(Join-Path $Root 'cache'),(Join-Path $Root 'locks'),(Join-Path $Root 'transactions')|Out-Null
$ConfigHome=(Resolve-Path $ConfigHome).Path
$Release=Get-Content -Raw (Join-Path $PackageRoot 'release.json')|ConvertFrom-Json
$Version=[int]$Release.version
$StatePath=Join-Path $Root 'state.json'; $State=$null
if(Test-Path $StatePath){$State=Get-Content -Raw $StatePath|ConvertFrom-Json}
if($null -eq $State){$State=[pscustomobject]@{schema_version=1;installed_version=$Version;hub_base_url=$HubBaseUrl.TrimEnd('/');api_key_env=$ApiKeyEnv;clients=[pscustomobject]@{}}}
if($State.hub_base_url -and $State.hub_base_url.TrimEnd('/') -ne $HubBaseUrl.TrimEnd('/')){throw "Existing client integration points to a different Team Skill Hub: $($State.hub_base_url) != $HubBaseUrl"}
if($State.installed_version -and [int]$State.installed_version -gt $Version){throw "A newer Team Skill Hub client integration v$($State.installed_version) is already installed; refusing downgrade to v$Version"}
$State.schema_version=1;$State.installed_version=$Version;$State.hub_base_url=$HubBaseUrl.TrimEnd('/');$State.api_key_env=$ApiKeyEnv
if(-not $State.clients){$State|Add-Member -Force NoteProperty clients ([pscustomobject]@{})}
$ClientState=[pscustomobject]@{enabled=$true;config_home=$ConfigHome;server_name=$ServerName}
if($State.clients.PSObject.Properties[$Client]){$State.clients.$Client=$ClientState}else{$State.clients|Add-Member NoteProperty $Client $ClientState}
$ReleaseDir=Join-Path $Root "releases\v$Version";Remove-Item -Recurse -Force $ReleaseDir -ErrorAction SilentlyContinue;New-Item -ItemType Directory -Force -Path $ReleaseDir|Out-Null
foreach($Name in @('runtime','updater','templates')){$Source=Join-Path $PackageRoot $Name;if(Test-Path $Source){Copy-Item -Recurse -Force $Source (Join-Path $ReleaseDir $Name)}}
if(Test-Path $PackageScripts){Copy-Item -Recurse -Force $PackageScripts (Join-Path $ReleaseDir 'scripts')}
Copy-Item -Force (Join-Path $PackageRoot 'release.json') (Join-Path $ReleaseDir 'release.json')
foreach($Name in @('team-skill-hub-client','team-skill-hub-client.ps1')){$Source=Join-Path $PackageRoot "runtime\$Name";if(Test-Path $Source){Copy-Item -Force $Source (Join-Path $Root "bin\$Name")}}
$Tmp="$StatePath.tmp";$Utf8NoBom=New-Object System.Text.UTF8Encoding($false);[System.IO.File]::WriteAllText($Tmp,(($State|ConvertTo-Json -Depth 20)+[Environment]::NewLine),$Utf8NoBom);Move-Item -Force $Tmp $StatePath
Set-Content -Encoding ascii (Join-Path $Root 'current') "$Version"
