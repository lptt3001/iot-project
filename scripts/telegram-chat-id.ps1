$ErrorActionPreference = 'Stop'

$protectedToken = Read-Host 'Telegram bot token (hidden)' -AsSecureString
try {
    $token = [System.Net.NetworkCredential]::new('', $protectedToken).Password.Trim()
    if ($token -cnotmatch '^\d{5,20}:[a-zA-Z0-9_-]{25,100}$') {
        throw 'Invalid bot token format.'
    }
    try {
        $updates = Invoke-RestMethod -Uri "https://api.telegram.org/bot${token}/getUpdates" -Method Post -TimeoutSec 15
    } catch {
        throw 'Telegram did not return updates. Check the token and use a dedicated bot without a webhook.'
    }
    $chats = $updates.result | ForEach-Object { $_.message.chat } | Where-Object { $_.id } |
        Sort-Object id -Unique | Select-Object id, type, title, first_name, username
    if (-not $chats) {
        throw 'Send /start in the intended chat first, then run this script again.'
    }
    $chats | Format-Table -AutoSize
} finally {
    $token = $null
    $protectedToken.Dispose()
}
