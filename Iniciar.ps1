param([switch]$EnRed)

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    $runtime = Get-AppxPackage -Name OpenAI.CodexPrimaryRuntime -ErrorAction SilentlyContinue
    if ($runtime) {
        $bundledNode = Join-Path $runtime.InstallLocation 'dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $bundledNode) { $nodeCommand = Get-Item -LiteralPath $bundledNode }
    }
}
if (-not $nodeCommand) { throw 'Instala Node.js 24 o superior antes de iniciar Inventario LEGO.' }

$nodePath = if ($nodeCommand.Source) { $nodeCommand.Source } else { $nodeCommand.FullName }
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$originalHost = $env:APP_HOST
$originalPassword = $env:APP_PASSWORD
$inventoryPort = if ($env:APP_PORT) { $env:APP_PORT } else { '4173' }
try {
    if ($EnRed) {
        $env:APP_HOST = '0.0.0.0'
        if (-not $env:APP_PASSWORD) {
            $inventoryPassword = Read-Host 'Contraseña de la colección (mínimo 12 caracteres)' -AsSecureString
            $env:APP_PASSWORD = [Net.NetworkCredential]::new('', $inventoryPassword).Password
        }
        if ($env:APP_PASSWORD.Length -lt 12) { throw 'La contraseña debe tener al menos 12 caracteres.' }
        Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred |
            Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
            ForEach-Object { Write-Host ('En la tablet: http://{0}:{1}' -f $_.IPAddress, $inventoryPort) }
    } else {
        $env:APP_HOST = '127.0.0.1'
    }
    Write-Host ('En este ordenador: http://127.0.0.1:{0}' -f $inventoryPort)
    & $nodePath (Join-Path $projectRoot 'server.mjs')
} finally {
    $env:APP_HOST = $originalHost
    $env:APP_PASSWORD = $originalPassword
}
