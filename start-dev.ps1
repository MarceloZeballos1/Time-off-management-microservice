# start-dev.ps1
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host "Iniciando Mock HCM Server en el puerto 4000..."
$hcmProcess = Start-Process -FilePath "node" -ArgumentList ".\mock-hcm-server\server.js" -PassThru -NoNewWindow

Write-Host "Esperando a que Mock HCM Server esté activo en el puerto 4000..."
$isUp = $false
while (-not $isUp) {
    try {
        $connection = Test-NetConnection localhost -Port 4000 -WarningAction SilentlyContinue
        if ($connection.TcpTestSucceeded) {
            $isUp = $true
        } else {
            Start-Sleep -Seconds 1
        }
    } catch {
        Start-Sleep -Seconds 1
    }
}
Write-Host "¡Mock HCM Server inicializado y respondiendo!"

Write-Host "Iniciando Time-Off Service (NestJS) en el puerto 3000..."
Set-Location -Path ".\time-off-service"
npm run start:dev

# Clean up para matar el proceso del mock cuando detengas NestJS
Stop-Process -Id $hcmProcess.Id -Force
