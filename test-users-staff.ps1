# test-users-staff.ps1
# Run from the project root while "npm run dev" is running in another terminal.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''

function Call($method, $path, $token, $body) {
    $script:lastMsg = ''
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $params.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Depth 6 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null } }
        $text = $_.ErrorDetails.Message
        if (-not $text) {
            try { $text = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch { $text = '' }
        }
        $json = $null
        try { $json = $text | ConvertFrom-Json } catch { }
        if ($null -ne $json -and $null -ne $json.error) { $script:lastMsg = $json.error.message }
        return @{ status = [int]$resp.StatusCode; json = $json }
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
    if ($r.status -ne 200) {
        Write-Host "Login failed for $email (status $($r.status))" -ForegroundColor Red
        exit 1
    }
    return $r.json.data.accessToken
}

function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        exit 1
    }
}

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
function NewUser($label) {
    $email = "$label$stamp@vendorshub.test"
    $r = Call 'POST' '/auth/register' $null @{ name = "$label Test"; email = $email; password = 'Password123!'; role = 'CUSTOMER' }
    Need ($r.status -eq 201) "registering $label"
    return @{ token = $r.json.data.accessToken; id = $r.json.data.user.id; email = $email }
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$cust = Login 'customer@vendorshub.test'
$admin = Login 'admin@vendorshub.test'
$owner = Login 'owner1@vendorshub.test'
$staff2 = Login 'owner2@vendorshub.test'
$techId = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
$A = NewUser 'usera'
$B = NewUser 'userb'
$phoneA = '01' + (Get-Random -Minimum 100000000 -Maximum 999999999)

# ---- 1. profile ----
$r = Call 'PATCH' '/users/me' $null @{ name = 'No Token' }
Check 'the profile needs a login' $r.status 401
$r = Call 'PATCH' '/users/me' $A.token @{ name = 'Alice Updated' }
Check 'the name is updated' $r.status 200
$r = Call 'PATCH' '/users/me' $A.token @{ phone = '12345' }
Check 'an invalid phone is rejected' $r.status 400
$r = Call 'PATCH' '/users/me' $A.token @{ phone = $phoneA }
Check 'a valid phone is saved' $r.status 200
$r = Call 'PATCH' '/users/me' $B.token @{ phone = $phoneA }
Check 'a phone used by someone else is rejected' $r.status 409
$r = Call 'PATCH' '/users/me' $A.token @{}
Check 'an empty update is rejected' $r.status 400
$r = Call 'PATCH' '/users/me' $A.token @{ avatarUrl = 'not a url' }
Check 'an invalid avatar address is rejected' $r.status 400
$r = Call 'PATCH' '/users/me' $A.token @{ avatarUrl = 'https://example.com/a.png' }
Check 'a valid avatar address is saved' $r.status 200
$me = Call 'GET' '/auth/me' $A.token $null
Check 'the change shows in my profile' $me.json.data.name 'Alice Updated'

# ---- 2. addresses ----
$r = Call 'GET' '/users/me/addresses' $A.token $null
Check 'a new user has no addresses' @($r.json.data).Count 0
$r = Call 'POST' '/users/me/addresses' $A.token @{ label = 'Home'; line1 = 'House 12, Road 5'; area = 'Dhanmondi'; phone = $phoneA }
Check 'the first address is created' $r.status 201
$a1 = $r.json.data.id
Need $a1 'the first address'
Check 'the first address becomes the default' $r.json.data.isDefault $true
$r = Call 'POST' '/users/me/addresses' $A.token @{ line1 = 'Flat 4B, Block C'; phone = $phoneA }
$a2 = $r.json.data.id
Check 'the second address is not the default' $r.json.data.isDefault $false
Check 'the city defaults to Dhaka' $r.json.data.city 'Dhaka'
$r = Call 'POST' '/users/me/addresses' $A.token @{ line1 = 'Office, Level 3, Tower'; phone = $phoneA; isDefault = $true }
$a3 = $r.json.data.id
Check 'a new default is created' $r.json.data.isDefault $true
$list = @((Call 'GET' '/users/me/addresses' $A.token $null).json.data)
Check 'three addresses are saved' $list.Count 3
Check 'exactly one is the default' @($list | Where-Object { $_.isDefault }).Count 1
Check 'the newest default replaced the old one' @($list | Where-Object { $_.isDefault })[0].id $a3
$r = Call 'PATCH' "/users/me/addresses/$a2" $A.token @{ isDefault = $true }
Check 'another address becomes the default' $r.status 200
$list = @((Call 'GET' '/users/me/addresses' $A.token $null).json.data)
Check 'still exactly one default' @($list | Where-Object { $_.isDefault }).Count 1
$r = Call 'PATCH' "/users/me/addresses/$a2" $A.token @{ isDefault = $false }
Check 'the default cannot be unset directly' $r.status 400
$r = Call 'PATCH' "/users/me/addresses/$a1" $A.token @{ line1 = 'House 99, Road 1' }
Check 'an address is edited' $r.status 200
Check 'the edit is saved' $r.json.data.line1 'House 99, Road 1'
$r = Call 'PATCH' "/users/me/addresses/$a1" $B.token @{ line1 = 'Hijacked address 1' }
Check 'someone else cannot edit my address' $r.status 404
$r = Call 'DELETE' "/users/me/addresses/$a1" $B.token $null
Check 'someone else cannot delete my address' $r.status 404
$r = Call 'POST' '/users/me/addresses' $A.token @{ line1 = 'Bad phone address'; phone = '123' }
Check 'an invalid address phone is rejected' $r.status 400
$r = Call 'DELETE' "/users/me/addresses/$a2" $A.token $null
Check 'the default address is deleted' $r.status 200
$list = @((Call 'GET' '/users/me/addresses' $A.token $null).json.data)
Check 'two addresses are left' $list.Count 2
Check 'another address took over as the default' @($list | Where-Object { $_.isDefault }).Count 1
for ($i = 1; $i -le 8; $i++) {
    Call 'POST' '/users/me/addresses' $A.token @{ line1 = "Extra address number $i"; phone = $phoneA } | Out-Null
}
$r = Call 'POST' '/users/me/addresses' $A.token @{ line1 = 'The eleventh address'; phone = $phoneA }
Check 'the limit of 10 addresses is enforced' $r.status 409

# ---- 3. checkout with a saved address ----
$p = Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null
$all = @($p.json.data.selectedListing) + @($p.json.data.otherListings)
$lid = (@($all | Where-Object { $_.shop.id -eq $techId }))[0].id
Call 'PATCH' "/shops/$techId/listings/$lid" $owner @{ availability = 'IN_STOCK'; stockQty = 50 } | Out-Null
$default = @((Call 'GET' '/users/me/addresses' $A.token $null).json.data | Where-Object { $_.isDefault })[0]

Call 'DELETE' '/cart' $A.token $null | Out-Null
Call 'POST' '/cart/items' $A.token @{ listingId = $lid; quantity = 1 } | Out-Null
$bAddr = (Call 'POST' '/users/me/addresses' $B.token @{ line1 = 'Bobs private address'; phone = '01711111111' }).json.data.id
$choice = @{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; addressId = $bAddr }
$r = Call 'POST' '/checkout' $A.token @{ shops = @($choice) }
Check 'another user''s saved address is refused' $r.status 400
$choice = @{ shopId = $techId; deliveryMethod = 'VENDOR_DELIVERY'; paymentMethod = 'CASH_ON_DELIVERY'; addressId = $default.id }
$r = Call 'POST' '/checkout' $A.token @{ shops = @($choice) }
Check 'checkout with a saved address works' $r.status 201
$order = $r.json.data.orders[0]
Check 'the order carries the saved address' ($order.deliveryAddress -like "*$($default.line1)*") $true
Call 'POST' "/shops/$techId/orders/$($order.id)/status" $owner @{ status = 'CANCELLED'; reason = 'Test cleanup' } | Out-Null

# ---- 4. shop staff ----
$r = Call 'GET' "/shops/$techId/staff" $owner $null
Check 'the owner sees the team' $r.status 200
Check 'the team shows the owner' $r.json.data.owner.email 'owner1@vendorshub.test'
Check 'the seeded staff member is listed' @($r.json.data.staff | Where-Object { $_.email -eq 'owner2@vendorshub.test' }).Count 1
$r = Call 'GET' "/shops/$techId/staff" $cust $null
Check 'a customer cannot see the team' $r.status 403
$r = Call 'POST' "/shops/$techId/staff" $staff2 @{ email = $B.email }
Check 'a staff member cannot add staff' $r.status 403
$r = Call 'POST' "/shops/$techId/staff" $cust @{ email = $B.email }
Check 'a customer cannot add staff' $r.status 403
$r = Call 'POST' "/shops/$techId/staff" $owner @{ email = "nobody$stamp@vendorshub.test" }
Check 'an unknown email is rejected' $r.status 404
$r = Call 'POST' "/shops/$techId/staff" $owner @{ email = 'owner1@vendorshub.test' }
Check 'the owner cannot be added as staff' $r.status 400
$r = Call 'POST' "/shops/$techId/staff" $owner @{ email = 'admin@vendorshub.test' }
Check 'an admin cannot be added as staff' $r.status 400
$r = Call 'POST' "/shops/$techId/staff" $owner @{ email = $B.email; title = 'Cashier' }
Check 'the owner adds a staff member' $r.status 201
Check 'the new staff member must log in again' $r.json.data.mustLogInAgain $true
$r = Call 'GET' "/dashboard/shop/$techId" $B.token $null
Check 'the old session still has the customer role' $r.status 403
$bToken = Login $B.email
$r = Call 'GET' "/dashboard/shop/$techId" $bToken $null
Check 'after a new login the staff member can work' $r.status 200
$r = Call 'POST' "/shops/$techId/staff" $owner @{ email = $B.email }
Check 'adding the same person twice is rejected' $r.status 409
$r = Call 'GET' "/shops/$techId/staff" $owner $null
Check 'the title is saved' (@($r.json.data.staff | Where-Object { $_.email -eq $B.email })[0].title) 'Cashier'
$r = Call 'DELETE' "/shops/$techId/staff/$($B.id)" $staff2 $null
Check 'a staff member cannot remove staff' $r.status 403
$r = Call 'DELETE' "/shops/$techId/staff/$($B.id)" $owner $null
Check 'the owner removes the staff member' $r.status 200
$r = Call 'DELETE' "/shops/$techId/staff/$($B.id)" $owner $null
Check 'removing twice returns 404' $r.status 404
$bToken = Login $B.email
$r = Call 'GET' "/dashboard/shop/$techId" $bToken $null
Check 'the removed person is a customer again' $r.status 403

# ---- 5. admin user management ----
$r = Call 'GET' '/admin/users' $cust $null
Check 'a customer cannot list users' $r.status 403
$q = [uri]::EscapeDataString($B.email)
$r = Call 'GET' "/admin/users?q=$q" $admin $null
Check 'admin finds a user by email' @($r.json.data | Where-Object { $_.id -eq $B.id }).Count 1
$r = Call 'GET' '/admin/users?role=ADMIN' $admin $null
Check 'the role filter returns only admins' @($r.json.data | Where-Object { $_.role -ne 'ADMIN' }).Count 0
$r = Call 'GET' "/admin/users/$($B.id)" $admin $null
Check 'user detail works' $r.status 200
Check 'the detail shows the email' $r.json.data.email $B.email
$r = Call 'PATCH' "/admin/users/$($B.id)/status" $admin @{ isActive = $false; reason = 'no' }
Check 'a block needs a proper reason' $r.status 400
$r = Call 'PATCH' "/admin/users/$($B.id)/status" $admin @{ isActive = $false; reason = 'Spam activity reported.' }
Check 'admin blocks a user' $r.status 200
$r = Call 'POST' '/auth/login' $null @{ email = $B.email; password = 'Password123!' }
Check 'a blocked user cannot log in' $r.status 401
$r = Call 'GET' "/admin/users?isActive=false&q=$q" $admin $null
Check 'the blocked filter lists the user' @($r.json.data | Where-Object { $_.id -eq $B.id }).Count 1
$r = Call 'PATCH' "/admin/users/$($B.id)/status" $admin @{ isActive = $false; reason = 'Spam activity reported.' }
Check 'blocking twice is rejected' $r.status 409
$r = Call 'PATCH' "/admin/users/$($B.id)/status" $admin @{ isActive = $true; reason = 'Appeal accepted.' }
Check 'admin unblocks the user' $r.status 200
$r = Call 'POST' '/auth/login' $null @{ email = $B.email; password = 'Password123!' }
Check 'the unblocked user can log in' $r.status 200
$adminId = (Call 'GET' '/auth/me' $admin $null).json.data.id
$r = Call 'PATCH' "/admin/users/$adminId/status" $admin @{ isActive = $false; reason = 'Blocking myself.' }
Check 'an admin cannot block themselves' $r.status 400
$r = Call 'PATCH' "/admin/users/$adminId/role" $admin @{ role = 'CUSTOMER'; reason = 'Demoting myself.' }
Check 'an admin cannot change their own role' $r.status 400
$r = Call 'PATCH' "/admin/users/$($B.id)/role" $admin @{ role = 'SHOP_OWNER'; reason = 'Opens a shop soon.' }
Check 'admin changes a role' $r.status 200
$r = Call 'PATCH' "/admin/users/$($B.id)/role" $admin @{ role = 'SHOP_OWNER'; reason = 'Opens a shop soon.' }
Check 'setting the same role again is rejected' $r.status 409
$owner1Id = (Call 'GET' '/auth/me' $owner $null).json.data.id
$r = Call 'PATCH' "/admin/users/$owner1Id/role" $admin @{ role = 'CUSTOMER'; reason = 'Trying to demote an owner.' }
Check 'an owner of shops cannot be demoted' $r.status 409
$a = Call 'GET' "/admin/audit-logs?entityType=User&entityId=$($B.id)" $admin $null
Check 'user changes are audited' (@($a.json.data).Count -ge 3) $true

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host 'Test users were created. Run "node --env-file=.env prisma/seed.js" to reset the demo data.'