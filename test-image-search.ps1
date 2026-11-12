# test-image-search.ps1 (POST /search/by-image in MOCK mode: shape, file rules, limits, nothing stored)
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
function Check($name, $actual, $expected) {
    if ($actual -eq $expected) { Write-Host "PASS  $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "FAIL  $name (got '$actual', expected '$expected')" -ForegroundColor Red; $script:fail++ }
}
try { Invoke-WebRequest 'http://localhost:4000/health' -UseBasicParsing | Out-Null } catch { Write-Host 'The API is not running.' -ForegroundColor Red; exit 1 }
# never spend real AI quota in tests
if (Select-String -Path .env -Pattern '^\s*SEARCH_IMAGE_MODE\s*=\s*gemini' -Quiet) {
    Write-Host 'STOP: SEARCH_IMAGE_MODE=gemini in .env. Set it to mock (and restart) before running this test.' -ForegroundColor Red
    exit 1
}

$tmp = Join-Path $env:TEMP 'vh-image-search'
node scripts/make-image-fixtures.mjs $tmp | Out-Null
# POST one file; returns status, json and the Cache-Control header
function Search($token, $field, $file, $type) {
    $out = Join-Path $tmp 'resp.json'; $hdr = Join-Path $tmp 'headers.txt'
    foreach ($x in @($out, $hdr)) { if (Test-Path $x) { Remove-Item $x } }
    $cargs = @('-s', '-o', $out, '-D', $hdr, '-w', '%{http_code}', '-X', 'POST')
    if ($file) { $cargs += @('-F', "$field=@$(Join-Path $tmp $file);type=$type") } else { $cargs += @('-F', 'note=nothing') }
    if ($token) { $cargs += @('-H', "Authorization: Bearer $token") }
    $code = & curl.exe @cargs "$base/search/by-image"
    $json = $null; if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    $cache = ''; if (Test-Path $hdr) { $line = Select-String -Path $hdr -Pattern '^Cache-Control:' | Select-Object -First 1; if ($line) { $cache = $line.Line.Split(':', 2)[1].Trim() } }
    return @{ status = [int]$code; json = $json; cache = $cache }
}
function FileCount { return @(Get-ChildItem 'uploads' -Recurse -File -ErrorAction SilentlyContinue).Count }

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$reg = Invoke-RestMethod -Method Post "$base/auth/register" -ContentType 'application/json' -Body (@{ name = 'Photo Search'; email = "ps$stamp@vendorshub.test"; password = 'Password123!' } | ConvertTo-Json)
$user = $reg.data.accessToken
# fingerprints for the seed products (the full run reseeds first)
node --env-file=.env scripts/backfill-fingerprints.mjs | Out-Null
$before = FileCount

# ---- 1. the answer ----
$r = Search $user 'photo' 'valid.jpg' 'image/jpeg'
Check 'a photo is accepted' $r.status 200
Check 'the answer has the search words' $r.json.data.query 'galaxy'
Check 'the answer has a label' $r.json.data.label 'Test result'
Check 'category is null when nothing fits' ($null -eq $r.json.data.category) $true
Check 'the answer is never cached' $r.cache 'no-store'
Check 'the answer has a products list' ($null -ne $r.json.data.products) $true
Check 'visual search finds products' (@($r.json.data.products).Count -ge 1) $true
$first = @($r.json.data.products)[0]
Check 'a result has price, shops and match' (($first.lowestPrice -gt 0) -and ($first.shopCount -ge 1) -and (@('photo', 'title') -contains $first.match)) $true

# a unique photo on the A55: searching with the same photo must put the A55 first
$noise = Join-Path $tmp 'noise.jpg'
node -e "require('sharp')({create:{width:800,height:600,channels:3,noise:{type:'gaussian',mean:128,sigma:60}}}).jpeg().toFile(process.argv[1])" $noise
$admin = (Invoke-RestMethod -Method Post "$base/auth/login" -ContentType 'application/json' -Body '{"email":"admin@vendorshub.test","password":"Password123!"}').data.accessToken
$a55 = (Invoke-RestMethod "$base/products/galaxy-a55-5g-8-128gb").data.product.id
& curl.exe -s -o NUL -X PUT -H "Authorization: Bearer $admin" -F "image=@$noise;type=image/jpeg" "$base/admin/products/$a55/images"
$top = $null
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1 # the photo fingerprint is made in the background
    $s = Search $user 'photo' 'noise.jpg' 'image/jpeg'
    $top = @($s.json.data.products)[0]
    if ($top.slug -eq 'galaxy-a55-5g-8-128gb' -and $top.match -eq 'photo') { break }
}
Check 'the same photo finds its product first' $top.slug 'galaxy-a55-5g-8-128gb'
Check 'found by photo similarity' $top.match 'photo'
$before = FileCount # the A55 photo above added 2 files on purpose; searches from here on must add none
Check 'a PNG works' (Search $user 'photo' 'valid.png' 'image/png').status 200
Check 'a WebP works' (Search $user 'photo' 'valid.webp' 'image/webp').status 200

# ---- 2. file rules ----
Check 'no file: 400' (Search $user 'photo' $null $null).status 400
Check 'a wrong field name: 400' (Search $user 'image' 'valid.jpg' 'image/jpeg').status 400
Check 'an SVG: 400' (Search $user 'photo' 'script.svg' 'image/svg+xml').status 400
Check 'a fake JPG: 400' (Search $user 'photo' 'code.jpg' 'image/jpeg').status 400
Check 'a text file sent as PNG: 400' (Search $user 'photo' 'text.png' 'image/png').status 400
Check 'a PDF: 400' (Search $user 'photo' 'doc.pdf' 'application/pdf').status 400
$big = Search $user 'photo' 'huge.jpg' 'image/jpeg'
Check 'a 6 MB photo: 413' $big.status 413
Check 'error answers are not cached either' $big.cache 'no-store'

# ---- 3. nothing is stored ----
Check 'no file was written to the uploads folder' (FileCount) $before

# ---- 4. guests: 10 per hour per IP ----
$limited = $false
for ($i = 1; $i -le 11 -and -not $limited; $i++) {
    if ((Search $null 'photo' 'valid.jpg' 'image/jpeg').status -eq 429) { $limited = $true }
}
Check 'guests get 429 after 10 searches per hour' $limited $true

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"