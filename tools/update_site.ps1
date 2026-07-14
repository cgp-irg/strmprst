# Еженедельное обновление карты строек.
#   1. подтягивает свежий код сайта из main
#   2. качает данные с stroimprosto.mos.ru (нужен российский IP)
#   3. кладёт сайт + данные в ветку gh-pages одним коммитом (force-push, история не растёт)
#
# Запускается Планировщиком задач Windows (задача strmprst-weekly); логи — logs\update-<дата>.log
# Токен GitHub читается из файла (по умолчанию %USERPROFILE%\.strmprst\gh_token.txt).
#
# Файл должен оставаться в UTF-8 **с BOM**: Windows PowerShell 5.1 иначе читает кириллицу как ANSI.

[CmdletBinding()]
param(
    [string]$RepoDir,
    [string]$TokenFile = (Join-Path $env:USERPROFILE '.strmprst\gh_token.txt'),
    [string]$Remote    = 'https://github.com/cgp-irg/strmprst.git',
    [int]$Workers      = 12,
    [switch]$SkipPush,             # только собрать данные, ничего не публиковать
    [switch]$SkipData              # не качать заново, взять уже собранное build\site\data
)

$ErrorActionPreference = 'Stop'
$env:GIT_TERMINAL_PROMPT = '0'
# иначе PS 5.1 читает вывод python/git в OEM-кодировке и в логе получаются кракозябры
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $RepoDir) {
    $RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}

$logDir = Join-Path $RepoDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir ("update-{0:yyyy-MM-dd}.log" -f (Get-Date))

function Write-Log([string]$Message) {
    $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $Message
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Invoke-Step([string]$What, [scriptblock]$Action) {
    Write-Log $What
    # git пишет предупреждения в stderr; в PS 5.1 при ErrorActionPreference=Stop это стало бы
    # исключением ещё до проверки кода возврата, поэтому об успехе судим только по коду выхода
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Action 2>&1 | ForEach-Object {
            $text = "$_"
            Write-Host "    $text"
            Add-Content -Path $logFile -Value "    $text" -Encoding UTF8
        }
    }
    finally {
        $ErrorActionPreference = $previous
    }
    if ($LASTEXITCODE -ne 0) { throw "$What — код выхода $LASTEXITCODE" }
}

try {
    Write-Log "=== старт обновления, репозиторий $RepoDir ==="

    $python = (Get-Command python -ErrorAction Stop).Source
    $build  = Join-Path $RepoDir 'build\site'

    # 1. свежий код сайта
    Invoke-Step 'git fetch' { git -C $RepoDir fetch --depth 1 origin main }
    Invoke-Step 'git reset --hard origin/main' { git -C $RepoDir reset --hard origin/main }

    # 2. данные
    if ($SkipData) {
        if (-not (Test-Path (Join-Path $build 'data\metadata.json'))) {
            throw "SkipData: нет готовых данных в $build\data"
        }
        Write-Log 'SkipData: используются уже собранные данные'
    }
    else {
        if (Test-Path $build) { Remove-Item -Recurse -Force $build }
        New-Item -ItemType Directory -Path $build -Force | Out-Null
        Invoke-Step 'сбор данных с stroimprosto.mos.ru' {
            & $python (Join-Path $RepoDir 'tools\update_data.py') --out (Join-Path $build 'data') --workers $Workers
        }
    }

    # 2а. предыдущая публикация (ветка gh-pages) — источник состояния для архива
    $prev = Join-Path $RepoDir 'build\prev'
    if (-not (Test-Path (Join-Path $prev '.git'))) {
        Remove-Item -Recurse -Force $prev -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path $prev -Force | Out-Null
        Invoke-Step 'git init (prev)' { git -C $prev init -q }
        Invoke-Step 'git remote add' { git -C $prev remote add origin $Remote }
    }
    $prevOk = $true
    try {
        Invoke-Step 'git fetch gh-pages (прошлая публикация)' { git -C $prev fetch -q --depth 1 origin gh-pages }
        Invoke-Step 'git checkout gh-pages' { git -C $prev checkout -q -f -B gh-pages FETCH_HEAD }
    }
    catch {
        $prevOk = $false
        Write-Log "прошлую публикацию получить не удалось ($($_.Exception.Message)) — архив не пополняем"
    }

    # 2б. архив: объекты, исчезнувшие из источника
    Invoke-Step 'архив исчезнувших объектов' {
        if ($prevOk) {
            & $python (Join-Path $RepoDir 'tools\merge_archive.py') --new (Join-Path $build 'data') --prev (Join-Path $prev 'data')
        }
        else {
            & $python (Join-Path $RepoDir 'tools\merge_archive.py') --new (Join-Path $build 'data')
        }
    }

    $meta = Get-Content (Join-Path $build 'data\metadata.json') -Raw -Encoding utf8 | ConvertFrom-Json
    Write-Log ("данные: {0} проектов, {1} полигонов, {2} организаций, ошибок загрузки {3}; в архиве {4} (новых {5})" -f `
        $meta.project_count, $meta.polygon_count, $meta.organization_count, ($meta.card_errors + $meta.ps_errors), `
        $meta.archived_count, $meta.archived_new)

    # 3. статика сайта рядом с данными
    foreach ($item in @('index.html', 'app.js', 'app.css', '.nojekyll')) {
        Copy-Item (Join-Path $RepoDir $item) $build -Force
    }
    Copy-Item (Join-Path $RepoDir 'vendor') $build -Recurse -Force

    if ($SkipPush) {
        Write-Log "SkipPush: сайт собран в $build, публикация пропущена"
        exit 0
    }

    # 4. публикация: ветка gh-pages переписывается одним коммитом
    if (-not (Test-Path $TokenFile)) { throw "нет файла с токеном GitHub: $TokenFile" }
    $token = (Get-Content $TokenFile -Raw).Trim()
    if (-not $token) { throw "файл токена пуст: $TokenFile" }
    $pushUrl = $Remote -replace '^https://', "https://x-access-token:$token@"

    Remove-Item -Recurse -Force (Join-Path $build '.git') -ErrorAction SilentlyContinue
    Push-Location $build
    try {
        Invoke-Step 'git init (gh-pages)' { git init -q -b gh-pages }
        Invoke-Step 'git config' {
            git config user.email 'bot@strmprst'
            git config user.name 'strmprst updater'
            git config core.autocrlf false
        }
        Invoke-Step 'git add' { git add -A }
        $message = "Данные stroimprosto на {0:yyyy-MM-dd}: {1} проектов" -f (Get-Date), $meta.project_count
        Invoke-Step 'git commit' { git commit -q -m $message }

        Write-Log 'git push --force origin gh-pages'
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $pushLog = (git push --force --quiet $pushUrl gh-pages:gh-pages 2>&1 |
                ForEach-Object { "$_" } | Out-String)
        }
        finally {
            $ErrorActionPreference = $previous
        }
        if ($LASTEXITCODE -ne 0) {
            $safe = ($pushLog -replace [regex]::Escape($token), '***') -replace '\s+', ' '
            throw "push не удался: $safe"
        }
    }
    finally {
        Pop-Location
        Remove-Item -Recurse -Force (Join-Path $build '.git') -ErrorAction SilentlyContinue
    }

    Write-Log '=== готово: gh-pages обновлена, GitHub Pages пересоберётся сам ==='
    Get-ChildItem $logDir -Filter 'update-*.log' | Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 12 | Remove-Item -Force -ErrorAction SilentlyContinue
    exit 0
}
catch {
    Write-Log ("ОШИБКА: " + ($_.Exception.Message -replace '\s+', ' '))
    exit 1
}
