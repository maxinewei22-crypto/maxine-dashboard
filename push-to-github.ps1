# 一键推送 Maxine 工作台到 GitHub
# 用法：右键这个文件 → 使用 PowerShell 运行

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Maxine 工作台 - GitHub 一键推送脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 项目路径
$projectPath = "C:\Users\17428\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6a66d380e194cb37aa9a4cdb"
Set-Location $projectPath

# 检查 Git
$gitCheck = git --version 2>$null
if (-not $gitCheck) {
    Write-Host "❌ 未检测到 Git，请先安装: https://git-scm.com/download/win" -ForegroundColor Red
    pause
    exit
}
Write-Host "✅ Git 已安装: $gitCheck" -ForegroundColor Green

# 输入 GitHub 用户名
Write-Host ""
Write-Host "请输入你的 GitHub 用户名（就是截图里 maxinewei22-crypto 这个）:" -ForegroundColor Yellow
$githubUser = Read-Host "GitHub用户名"
if (-not $githubUser) {
    Write-Host "❌ 用户名不能为空" -ForegroundColor Red
    pause
    exit
}

# 仓库名
$repoName = "maxine-dashboard"

Write-Host ""
Write-Host "正在初始化并推送代码到 https://github.com/$githubUser/$repoName ..." -ForegroundColor Cyan
Write-Host ""

# 执行 Git 命令
try {
    git init
    git add .
    git commit -m "Maxine工作台 - 首次提交"
    git branch -M main
    git remote add origin "https://github.com/$githubUser/$repoName.git"
    git push -u origin main

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  ✅ 推送成功！" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "仓库地址: https://github.com/$githubUser/$repoName" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "下一步：去 Render.com 创建 Web Service" -ForegroundColor Yellow
    Write-Host ""
} catch {
    Write-Host "❌ 出错了: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "常见问题：" -ForegroundColor Yellow
    Write-Host "1. 如果提示仓库已存在，去 https://github.com/$githubUser/$repoName 删掉重建" -ForegroundColor White
    Write-Host "2. 如果提示登录失败，请确保已在浏览器登录了 GitHub" -ForegroundColor White
}

pause
