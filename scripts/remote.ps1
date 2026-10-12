# Runs a local bash script on the game host: .\scripts\remote.ps1 scripts\remote\02-deploy.sh [args...]
# Host and key come from deploy\host.local.psd1 (not in git), e.g.:
#   @{ Target = 'user@203.0.113.10'; Key = 'C:\Users\me\.ssh\id_ed25519' }
param([Parameter(Mandatory)][string]$Script, [Parameter(ValueFromRemainingArguments)][string[]]$Args)
$cfg = Import-PowerShellDataFile (Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy\host.local.psd1')
$body = [IO.File]::ReadAllText((Resolve-Path $Script)) -replace "`r", '' -replace "^\uFEFF", ''
# base64 on the command line: PowerShell 5.1 pipes to native programs with a BOM and CRLF
$b64 = [Convert]::ToBase64String((New-Object Text.UTF8Encoding($false)).GetBytes($body))
$argline = ($Args | % { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
# one file per run: bash reads scripts lazily, so two runs sharing a path corrupt each other
ssh -i $cfg.Key -o BatchMode=yes -o IdentitiesOnly=yes $cfg.Target "f=`$(mktemp /tmp/trem-remote.XXXXXX); echo $b64 | base64 -d > `$f && bash `$f $argline; rc=`$?; rm -f `$f; exit `$rc"
exit $LASTEXITCODE
