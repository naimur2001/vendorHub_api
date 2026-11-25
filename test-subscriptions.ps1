# test-subscriptions.ps1 (shop subscriptions: off = everything allowed; plans, prices, start, payments, summary,
# usage; on = 402 PLAN_REQUIRED / 409 PLAN_LIMIT; plan requests; the daily job; refund, cancel)
# Run from the project root while the API runs. Removes its data and restores the settings at the end.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''
$script:lastCode = ''

function Call($method, $path, $token, $body) {
    $script:lastMsg = ''
    $script:lastCode = ''
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $params.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Depth 6 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json); raw = $r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null; raw = '' } }
        $text = $_.ErrorDetails.Message
        $json = $null
        try { $json = $text | ConvertFrom-Json } catch { }
        if ($null -ne $json -and $null -ne $json.error) {
            $script:lastMsg = $json.error.message
            if ($null -ne $json.error.details) { $script:lastCode = $json.error.details.code }
        }
        return @{ status = [int]$resp.StatusCode; json = $json; raw = $text }
    }
}

function Check($name, $actual, $expected) {
    if ($actual -eq $expected) {
        Write-Host "PASS  $name" -ForegroundColor Green
        $script:pass++
    } else {
        $extra = ''
        if ($script:lastMsg) { $extra = " | server said: $($script:lastMsg)" }
        Write-Host "FAIL  $name (got '$actual', expected '$expected')$extra" -ForegroundColor Red
        $script:fail++
    }
}

function Login($email) {
    $r = Call 'POST' '/auth/login' $null @{ email = $email; password = 'Password123!' }
    if ($r.status -ne 200) { Write-Host "Login failed for $email" -ForegroundColor Red; exit 1 }
    return $r.json.data.accessToken
}

function Helper() {
    $lines = @(node --env-file=.env scripts/delivery-test-helper.mjs @args)
    $line = @($lines | Where-Object { $_ -like '{*' -and $_ -notlike '*"level":*' }) | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line | ConvertFrom-Json)
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch { Write-Host 'The API is not running.' -ForegroundColor Red; exit 1 }

function SubHelper() {
    $lines = @(node --env-file=.env scripts/subscriptions-test-helper.mjs @args)
    $line = @($lines | Where-Object { $_ -like '{*' -and $_ -notlike '*"level":*' }) | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line | ConvertFrom-Json)
}

$since = [DateTime]::UtcNow.AddSeconds(-2).ToString('o')
$admin = Login 'admin@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'   # owns TechZone
$owner2 = Login 'owner2@vendorshub.test'  # owns Dhaka Mobile House, staff of TechZone
$cust = Login 'customer@vendorshub.test'
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$mobileId = (Call 'GET' '/shops/dhaka-mobile-house' $null $null).json.data.id
$prefix = "T$(Get-Date -Format 'MMddHHmmss')"
$snapFile = Join-Path $env:TEMP "vh-subs-$prefix.json"
$settings0 = (Call 'GET' '/admin/subscriptions/settings' $admin $null).json.data
SubHelper snapshot $snapFile $techId $mobileId | Out-Null
Call 'PATCH' '/admin/subscriptions/settings' $admin @{ subscriptionsEnabled = $false; graceDays = 7 } | Out-Null

function Cleanup {
    Call 'PATCH' '/admin/subscriptions/settings' $admin @{ subscriptionsEnabled = [bool]$settings0.subscriptionsEnabled; freeTrialDays = [int]$settings0.freeTrialDays; graceDays = [int]$settings0.graceDays } | Out-Null
    return (SubHelper cleanup $since $snapFile $prefix $techId $mobileId)
}
function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        Cleanup | Out-Null
        exit 1
    }
}
function Ent($shopId, $token) { return (Call 'GET' "/shops/$shopId/entitlements" $token $null).json.data }

# ---- 1. switched off: everything allowed, shop side says only enabled false ----
$e = Ent $techId $owner
Check 'off: entitlements enabled false, all 10 modules, no limits' "$($e.enabled)/$(@($e.modules).Count)/$($null -eq $e.limits.maxProducts)" 'False/10/True'
$sv = (Call 'GET' "/shops/$techId/subscription" $owner $null).json.data
Check 'off: GET subscription is only { enabled: false }' (Keys $sv) 'enabled'
Check 'off: staff can read the entitlements' (Ent $techId $owner2).enabled $false
Check 'a customer cannot read them -> 403' (Call 'GET' "/shops/$techId/entitlements" $cust $null).status 403
Check 'a bad shop id -> 400' (Call 'GET' '/shops/abc/entitlements' $owner $null).status 400
$free = @((Call 'GET' '/admin/subscription-plans' $admin $null).json.data | Where-Object { $_.code -eq 'FREE' })[0]
Check 'the FREE plan is seeded: all modules, no limits, 0 taka' "$(@($free.modules).Count)/$($null -eq $free.maxProducts)/$(@($free.prices)[0].amount)" '10/True/0'
$r = Call 'POST' "/shops/$techId/subscription/request" $owner @{ planId = $free.id; period = 'MONTHLY' }
Check 'off: a plan request answers enabled false and saves nothing' "$($r.status)/$($r.json.data.enabled)" '200/False'
Check 'off: the job does nothing' (SubHelper job 0).enabled $false
Check 'owner cannot use admin settings -> 403' (Call 'GET' '/admin/subscriptions/settings' $owner $null).status 403

# ---- 2. plans and prices ----
$p = Call 'POST' '/admin/subscription-plans' $admin @{ code = "$prefix"; nameEn = 'Growth'; nameBn = 'Growth BN'; modules = @('ANALYTICS', 'PROMOTIONS'); maxActiveDeals = 0; maxStaff = 5 }
Check 'create a plan -> 201, code upper case, unpublished' "$($p.status)/$($p.json.data.code)/$($p.json.data.isPublished)" "201/$prefix/False"
$planId = $p.json.data.id
Check 'the same code again -> 409 PLAN_CODE_TAKEN' (Call 'POST' '/admin/subscription-plans' $admin @{ code = "$prefix"; nameEn = 'Again'; nameBn = 'Again' }).status 409
Check 'an unknown module -> 400' (Call 'POST' '/admin/subscription-plans' $admin @{ code = "$($prefix)X"; nameEn = 'Bad'; nameBn = 'Bad'; modules = @('TELEPORT') }).status 400
$pp = Call 'PUT' "/admin/subscription-plans/$planId/prices" $admin @{ prices = @(@{ period = 'MONTHLY'; amount = 500 }, @{ period = 'HALF_YEARLY'; amount = 2700 }, @{ period = 'YEARLY'; amount = 5000 }) }
$byPeriod = @{}; foreach ($x in @($pp.json.data.prices)) { $byPeriod[$x.period] = $x }
Check 'prices: 3 periods' "$($pp.status)/$(@($pp.json.data.prices).Count)" '200/3'
Check 'half year saves 300 (10%)' "$($byPeriod.HALF_YEARLY.savingVsMonthly)/$($byPeriod.HALF_YEARLY.savingPercent)" '300/10'
Check 'yearly saves 1000 (16.7%), 417 a month' "$($byPeriod.YEARLY.savingVsMonthly)/$($byPeriod.YEARLY.savingPercent)/$($byPeriod.YEARLY.monthlyEquivalent)" '1000/16.7/417'
Check 'two prices for one period -> 400' (Call 'PUT' "/admin/subscription-plans/$planId/prices" $admin @{ prices = @(@{ period = 'MONTHLY'; amount = 1 }, @{ period = 'MONTHLY'; amount = 2 }) }).status 400
$r = Call 'PATCH' "/admin/subscription-plans/$($free.id)" $admin @{ isActive = $false }
Check 'the FREE plan cannot be switched off -> 409 FREE_PLAN' "$($r.status)/$($script:lastCode)" '409/FREE_PLAN'
Check 'the FREE plan cannot be deleted -> 409' (Call 'DELETE' "/admin/subscription-plans/$($free.id)" $admin $null).status 409

# ---- 3. start a shop on the plan (25 days ago), record a payment ----
$r = Call 'POST' "/admin/shops/$techId/subscription" $admin @{ planId = $planId; period = 'QUARTERLY' }
Check 'a period without a price -> 400 PRICE_NOT_SET' "$($r.status)/$($script:lastCode)" '400/PRICE_NOT_SET'
$start = [DateTime]::UtcNow.AddDays(-25).ToString('o')
$st = Call 'POST' "/admin/shops/$techId/subscription" $admin @{ planId = $planId; period = 'MONTHLY'; startsAt = $start; note = 'test' }
Check 'start -> 201 ACTIVE, unpaid, 500 due' "$($st.status)/$($st.json.data.status)/$($st.json.data.paidThisPeriod)/$($st.json.data.amountDue)" '201/ACTIVE/False/500'
$subId = $st.json.data.id
$un = @((Call 'GET' '/admin/subscriptions?unpaid=true' $admin $null).json.data | Where-Object { $_.id -eq $subId })
Check 'unpaid=true lists it' $un.Count 1
Check 'ONLINE payment -> 400 ONLINE_NOT_AVAILABLE' (Call 'POST' "/admin/subscriptions/$subId/payments" $admin @{ amount = 500; method = 'ONLINE' }).status 400
$pay = Call 'POST' "/admin/subscriptions/$subId/payments" $admin @{ amount = 500; method = 'MANUAL_BKASH'; reference = 'TRX123' }
Check 'payment -> 201, period start = start, end one month later' "$($pay.status)/$(([DateTime]$pay.json.data.payment.periodStart).ToUniversalTime().ToString('yyyy-MM-dd'))/$(([DateTime]$pay.json.data.payment.periodEnd - [DateTime]$pay.json.data.payment.periodStart).Days -ge 28)" "201/$(([DateTime]$start).ToUniversalTime().ToString('yyyy-MM-dd'))/True"
Check 'the payment moved currentPeriodEnd; paid, nothing due' "$($pay.json.data.subscription.currentPeriodEnd -eq $pay.json.data.payment.periodEnd)/$($pay.json.data.subscription.paidThisPeriod)/$($pay.json.data.subscription.amountDue)/$($pay.json.data.subscription.status)" 'True/True/0/ACTIVE'
Check 'unpaid=true no longer lists it' (@((Call 'GET' '/admin/subscriptions?unpaid=true' $admin $null).json.data | Where-Object { $_.id -eq $subId }).Count) 0
Check 'expiringInDays=7 lists it' (@((Call 'GET' '/admin/subscriptions?expiringInDays=7' $admin $null).json.data | Where-Object { $_.id -eq $subId }).Count) 1
$row = @((Call 'GET' "/admin/subscriptions?q=techzone&planId=$planId" $admin $null).json.data)[0]
Check 'list row: shop, owner, plan, last payment' "$($row.shop.slug)/$($row.shop.owner.email)/$($row.plan.code)/$([bool]$row.lastPaymentAt)" "techzone-electronics/owner1@vendorshub.test/$prefix/True"
Check 'detail has the payment' (@((Call 'GET' "/admin/subscriptions/$subId" $admin $null).json.data.payments).Count) 1

# ---- 4. summary and usage ----
$sum = (Call 'GET' '/admin/subscriptions/summary' $admin $null).json.data
$planRow = @($sum.byPlan | Where-Object { $_.planId -eq $planId })[0]
$revRow = @($sum.revenue.byPlan | Where-Object { $_.planId -eq $planId })[0]
Check 'summary: our plan has 1 shop and 500 revenue' "$($planRow.shops)/$($revRow.amount)" '1/500'
Check 'summary: paying, MRR and today revenue include it' "$($sum.counts.paying -ge 1)/$($sum.mrr -ge 500)/$((@($sum.revenue.byDay)[-1]).amount -ge 500)" 'True/True/True'
Check 'summary: 30 days, expiring counted' "$(@($sum.revenue.byDay).Count)/$($sum.counts.expiringNext7Days -ge 1)" '30/True'
Check 'summary: statuses add up to all shops' (($sum.byStatus.PSObject.Properties | Measure-Object -Property Value -Sum).Sum) $sum.shops
$use = (Call 'GET' '/admin/subscriptions/usage' $admin $null).json.data
Check 'usage: 10 modules and products' "$(@($use.modules).Count)/$($use.products.shopCount -ge 1)" '10/True'
Check 'usage: staff accounts include TechZone' (@((@($use.modules | Where-Object { $_.module -eq 'STAFF_ACCOUNTS' })[0]).top | Where-Object { $_.shopId -eq $techId }).Count) 1
Check 'usage: one module' (@((Call 'GET' '/admin/subscriptions/usage?moduleCode=BARGAINING' $admin $null).json.data.modules).Count) 1

# ---- 5. switch on: 402 / 409 ----
Need ((Call 'PATCH' '/admin/subscriptions/settings' $admin @{ subscriptionsEnabled = $true }).json.data.subscriptionsEnabled -eq $true) 'switching on'
$e = Ent $techId $owner
Check 'on: TechZone has its plan modules and limits' "$($e.enabled)/$((@($e.modules) | Sort-Object) -join ',')/$($e.limits.maxActiveDeals)/$($e.limits.maxStaff)" 'True/ANALYTICS,PROMOTIONS/0/5'
$r = Call 'POST' "/shops/$techId/listings/import" $owner $null
Check 'on: CSV import -> 402 PLAN_REQUIRED' "$($r.status)/$($script:lastCode)/$($r.json.error.details.module)" '402/PLAN_REQUIRED/CSV_IMPORT'
$r = Call 'POST' "/shops/$techId/staff" $owner @{ email = 'someone@vendorshub.test' }
Check 'on: add staff -> 402 STAFF_ACCOUNTS' "$($r.status)/$($r.json.error.details.module)" '402/STAFF_ACCOUNTS'
$lid = @((Call 'GET' "/shops/$techId/listings" $owner $null).json.data)[0].id
$r = Call 'POST' "/shops/$techId/deals" $owner @{ listingId = $lid; dealPrice = 1; endsAt = [DateTime]::UtcNow.AddDays(1).ToString('o') }
Check 'on: a deal past maxActiveDeals 0 -> 409 PLAN_LIMIT' "$($r.status)/$($script:lastCode)/$($r.json.error.details.name)/$($r.json.error.details.limit)" '409/PLAN_LIMIT/maxActiveDeals/0'
Check 'on: analytics is in the plan -> 200' (Call 'GET' "/shops/$techId/analytics" $owner $null).status 200
Check 'on: admins are never limited by a plan (not 402)' ((Call 'POST' "/shops/$techId/listings/import" $admin $null).status -ne 402) $true
Check 'on: a shop without a row is on FREE (all modules)' (@((Ent $mobileId $owner2).modules).Count) 10
$sv = (Call 'GET' "/shops/$techId/subscription" $owner $null).json.data
Check 'on: shop view has plan, status, limits with used' "$($sv.enabled)/$($sv.plan.code)/$($sv.subscription.status)/$($sv.limits.maxActiveDeals.limit)/$($null -ne $sv.limits.maxProducts.used)" "True/$prefix/ACTIVE/0/True"
Check 'on: an unpublished plan is not offered' (@($sv.plans | Where-Object { $_.id -eq $planId }).Count) 0

# ---- 6. plan requests ----
$r = Call 'POST' "/shops/$mobileId/subscription/request" $owner2 @{ planId = $planId; period = 'YEARLY' }
Check 'request an unpublished plan -> 400 PLAN_NOT_AVAILABLE' "$($r.status)/$($script:lastCode)" '400/PLAN_NOT_AVAILABLE'
Need ((Call 'PATCH' "/admin/subscription-plans/$planId" $admin @{ isPublished = $true }).status -eq 200) 'publishing the plan'
Check 'staff cannot request for the shop -> 403' (Call 'POST' "/shops/$techId/subscription/request" $owner2 @{ planId = $planId; period = 'YEARLY' }).status 403
$rq = Call 'POST' "/shops/$mobileId/subscription/request" $owner2 @{ planId = $planId; period = 'YEARLY' }
Check 'request -> 201 PENDING' "$($rq.status)/$($rq.json.data.request.status)" '201/PENDING'
$r = Call 'POST' "/shops/$mobileId/subscription/request" $owner2 @{ planId = $planId; period = 'MONTHLY' }
Check 'a second request -> 409 REQUEST_PENDING' "$($r.status)/$($script:lastCode)" '409/REQUEST_PENDING'
Check 'admins are told (SUBSCRIPTION_REQUEST)' (@((Call 'GET' '/notifications?limit=50' $admin $null).json.data | Where-Object { $_.type -eq 'SUBSCRIPTION_REQUEST' -and $_.data.shopId -eq $mobileId }).Count -ge 1) $true
$reqs = @((Call 'GET' '/admin/subscription-requests' $admin $null).json.data | Where-Object { $_.id -eq $rq.json.data.request.id })
Check 'admin sees the pending request' $reqs.Count 1
$ap = Call 'POST' "/admin/subscription-requests/$($rq.json.data.request.id)/approve" $admin @{ trialDays = 14 }
Check 'approve -> APPROVED with a subscription' "$($ap.status)/$($ap.json.data.status)/$([bool]$ap.json.data.subscriptionId)" '200/APPROVED/True'
Check 'approve again -> 409 NOT_PENDING' (Call 'POST' "/admin/subscription-requests/$($rq.json.data.request.id)/approve" $admin @{}).status 409
$ms = (Call 'GET' "/shops/$mobileId/subscription" $owner2 $null).json.data
Check 'Mobile House is on a 14-day trial, yearly, self serve' "$($ms.subscription.status)/$($ms.subscription.period)/$($ms.plan.code)" "TRIAL/YEARLY/$prefix"
Check 'the owner is told (SUBSCRIPTION_REQUEST_APPROVED)' (@((Call 'GET' '/notifications?limit=50' $owner2 $null).json.data | Where-Object { $_.type -eq 'SUBSCRIPTION_REQUEST_APPROVED' }).Count -ge 1) $true
$mobileSub = @((Call 'GET' "/admin/subscriptions?q=dhaka-mobile" $admin $null).json.data)[0]
Check 'the admin row says SELF_SERVE' $mobileSub.source 'SELF_SERVE'

# ---- 7. the job: expiring notice, past due, grace, expiry; trial end ----
$j0 = SubHelper job 0
Check 'job now: an expiring notice (7 days)' ($j0.expiringNotices -ge 1) $true
Check 'job again: no second notice' (SubHelper job 0).expiringNotices 0
$j1 = SubHelper job 150
Check 'job +150 h: TechZone past its end -> PAST_DUE' "$($j1.pastDue -ge 1)/$((Call 'GET' "/admin/subscriptions/$subId" $admin $null).json.data.status)" 'True/PAST_DUE'
Check 'Mobile House still in trial' (Call 'GET' "/admin/subscriptions/$($mobileSub.id)" $admin $null).json.data.status 'TRIAL'
$j2 = SubHelper job 342
$old = (Call 'GET' "/admin/subscriptions/$subId" $admin $null).json.data
Check 'job after the 7 grace days: EXPIRED, no longer current' "$($old.status)/$($old.isCurrent)" 'EXPIRED/False'
$now = @((Call 'GET' "/admin/subscriptions?q=techzone" $admin $null).json.data)[0]
Check 'TechZone fell back to FREE' "$($now.plan.code)/$($now.status)" 'FREE/FREE'
Check 'TechZone has every module again' (@((Ent $techId $owner).modules).Count) 10
Check 'trial over without payment -> PAST_DUE' (Call 'GET' "/admin/subscriptions/$($mobileSub.id)" $admin $null).json.data.status 'PAST_DUE'
$tn = @((Call 'GET' '/notifications?limit=50' $owner $null).json.data | ForEach-Object { $_.type })
Check 'owner told: expiring, past due, expired' "$($tn -contains 'SUBSCRIPTION_EXPIRING')/$($tn -contains 'SUBSCRIPTION_PAST_DUE')/$($tn -contains 'SUBSCRIPTION_EXPIRED')" 'True/True/True'

# ---- 8. refund, edit, cancel ----
$mp = Call 'POST' "/admin/subscriptions/$($mobileSub.id)/payments" $admin @{ amount = 5000; method = 'CASH' }
Check 'yearly payment from the trial end -> ACTIVE (12 months)' "$($mp.status)/$($mp.json.data.subscription.status)/$(([DateTime]$mp.json.data.payment.periodEnd - [DateTime]$mp.json.data.payment.periodStart).Days -ge 365)" '201/ACTIVE/True'
$rf = Call 'POST' "/admin/subscription-payments/$($mp.json.data.payment.id)/refund" $admin @{ note = 'test' }
Check 'refund -> REFUNDED and the period is taken back' "$($rf.status)/$($rf.json.data.payment.status)/$($rf.json.data.subscription.currentPeriodEnd -eq $mp.json.data.payment.periodStart)" '200/REFUNDED/True'
Check 'refund again -> 409 ALREADY_REFUNDED' (Call 'POST' "/admin/subscription-payments/$($mp.json.data.payment.id)/refund" $admin @{}).status 409
$ed = Call 'PATCH' "/admin/subscriptions/$($mobileSub.id)" $admin @{ extendDays = 10; cancelAtPeriodEnd = $true; note = 'partner' }
Check 'extend 10 days and cancel at period end' "$($ed.status)/$($ed.json.data.cancelAtPeriodEnd)/$(([DateTime]$ed.json.data.currentPeriodEnd - [DateTime]$rf.json.data.subscription.currentPeriodEnd).Days)" '200/True/10'
$cx = Call 'PATCH' "/admin/subscriptions/$($mobileSub.id)" $admin @{ status = 'CANCELLED' }
Check 'cancel now -> not current, the shop is on FREE' "$($cx.json.data.status)/$($cx.json.data.isCurrent)/$((@((Call 'GET' '/admin/subscriptions?q=dhaka-mobile' $admin $null).json.data)[0]).plan.code)" 'CANCELLED/False/FREE'
Check 'an ended subscription cannot be changed -> 409' (Call 'PATCH' "/admin/subscriptions/$($mobileSub.id)" $admin @{ note = 'x' }).status 409

# ---- 9. delete rules, back off ----
$r = Call 'DELETE' "/admin/subscription-plans/$planId" $admin $null
Check 'a used plan cannot be deleted -> 409 PLAN_IN_USE' "$($r.status)/$($script:lastCode)" '409/PLAN_IN_USE'
Check 'switch it off instead -> 200' (Call 'PATCH' "/admin/subscription-plans/$planId" $admin @{ isActive = $false }).json.data.isActive $false
$tmp = Call 'POST' '/admin/subscription-plans' $admin @{ code = "$($prefix)Z"; nameEn = 'Unused'; nameBn = 'Unused' }
Check 'an unused plan can be deleted' (Call 'DELETE' "/admin/subscription-plans/$($tmp.json.data.id)" $admin $null).status 200
Need ((Call 'PATCH' '/admin/subscriptions/settings' $admin @{ subscriptionsEnabled = $false }).json.data.subscriptionsEnabled -eq $false) 'switching off'
Check 'off again: no 402 (import without a file -> 400)' (Call 'POST' "/shops/$techId/listings/import" $owner $null).status 400

# ---- 10. cleanup ----
$out = Cleanup
Check 'cleanup removed the subscriptions and plans' "$($out.subscriptions -ge 4)/$($out.plans)" 'True/1'
Check 'settings restored' (Call 'GET' '/admin/subscriptions/settings' $admin $null).json.data.subscriptionsEnabled ([bool]$settings0.subscriptionsEnabled)

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
if ($script:fail -gt 0) { exit 1 }
