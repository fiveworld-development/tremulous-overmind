# Runs a local bash script on the game host: .\scripts\remote.ps1 scripts\remote\02-deploy.sh [args...]
# Host and key come from deploy\host.local.psd1 (not in git), e.g.:
#   @{ Target = 'user@203.0.113.10'; Key = 'C:\Users\me\.ssh\id_ed25519' }
param([Parameter(Mandatory)][string]$Script, [Parameter(ValueFromRemainingArguments)][string[]]$Args)
$cfg = Import-PowerShellDataFile (Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy\host.local.psd1')
$body = [IO.File]::ReadAllText((Resolve-Path $Script)) -replace "`r", '' -replace "^\uFEFF", ''
$argline = ($Args | % { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
$body | ssh -i $cfg.Key -o BatchMode=yes -o IdentitiesOnly=yes $cfg.Target "bash -s -- $argline"
exit $LASTEXITCODE
