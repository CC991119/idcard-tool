# 把当前文件夹的内容上传到 GitHub, 网址不变
# 用法: 在这个文件夹里右键 -> 在终端中打开, 然后输入  .\上传更新.ps1

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
$cfgPath = Join-Path $here '.deploy-config.json'

function Read-Config {
    if (Test-Path -LiteralPath $cfgPath) {
        return Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    }
    Write-Host ''
    Write-Host '第一次上传, 需要填三样东西 (以后就不用填了)' -ForegroundColor Cyan
    Write-Host ''
    $user = Read-Host '1. 你的 GitHub 用户名'
    $repo = Read-Host '2. 仓库名 (直接回车用 idcard-tool)'
    if ([string]::IsNullOrWhiteSpace($repo)) { $repo = 'idcard-tool' }
    Write-Host '3. 访问令牌 (粘贴后回车, 屏幕上不会显示出来)'
    $secure = Read-Host -AsSecureString
    $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    $cfg = [pscustomobject]@{ user = $user.Trim(); repo = $repo.Trim(); token = $token.Trim() }
    $cfg | ConvertTo-Json | Set-Content -LiteralPath $cfgPath -Encoding UTF8
    Write-Host ''
    Write-Host "已记住设置, 保存在 $cfgPath" -ForegroundColor DarkGray
    return $cfg
}

$cfg = Read-Config
$remote = "https://$($cfg.user):$($cfg.token)@github.com/$($cfg.user)/$($cfg.repo).git"
$pagesUrl = "https://$($cfg.user).github.io/$($cfg.repo)/"

# 不要把令牌和临时物传上去
$ignore = @('.deploy-config.json', '.git/')
Set-Content -LiteralPath (Join-Path $here '.gitignore') -Value $ignore -Encoding UTF8

if (-not (Test-Path -LiteralPath (Join-Path $here '.git'))) {
    Write-Host '正在初始化...' -ForegroundColor Cyan
    git init -q
    git branch -M main
}

git config user.name  $cfg.user
git config user.email "$($cfg.user)@users.noreply.github.com"
git remote remove origin 2>$null | Out-Null
git remote add origin $remote

Write-Host '正在打包文件...' -ForegroundColor Cyan
git add -A
$staged = git diff --cached --name-only
if ([string]::IsNullOrWhiteSpace($staged)) {
    Write-Host '没有任何改动, 不需要上传' -ForegroundColor Yellow
} else {
    git commit -q -m ("更新 " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
    Write-Host '正在上传到 GitHub...' -ForegroundColor Cyan
    git push -u origin main --force
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host '上传失败。常见原因:' -ForegroundColor Red
        Write-Host '  用户名或仓库名写错了' -ForegroundColor Red
        Write-Host '  令牌过期, 或者没给这个仓库的 Contents 读写权限' -ForegroundColor Red
        Write-Host ''
        Write-Host "想重新填写, 请删掉这个文件后再运行: $cfgPath" -ForegroundColor Yellow
        exit 1
    }
}

Write-Host ''
Write-Host '上传完成' -ForegroundColor Green
Write-Host "网址: $pagesUrl" -ForegroundColor Green
Write-Host '第一次上传后, 还需要在 GitHub 网页上开启 Pages, 见 部署步骤.md' -ForegroundColor DarkGray
