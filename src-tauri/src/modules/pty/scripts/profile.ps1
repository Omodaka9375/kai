# KAI-shell-integration (PowerShell)
# Emits OSC 7 (cwd) + OSC 133 A/B/D so the host tracks cwd and prompt boundaries.
#
# Launched via `pwsh -NoExit -File <this>`. -File skips $PROFILE, so we source
# it ourselves below. This gives the user their full environment (Oh-My-Posh,
# Starship, posh-git, custom modules, aliases, PATH) while still injecting our
# OSC hooks afterward.

if ($global:__KAI_HOOKS_LOADED) { return }
$global:__KAI_HOOKS_LOADED = $true

try {
    [Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $global:OutputEncoding    = [System.Text.UTF8Encoding]::new($false)
} catch {}

# Source the user's profile. -File suppresses automatic $PROFILE loading, so
# without this the user gets a bare shell with no customizations. Errors in the
# user's profile are caught so KAI still starts even if the profile is broken.
if ($PROFILE -and (Test-Path $PROFILE -ErrorAction SilentlyContinue)) {
    try { . $PROFILE } catch {
        Write-Warning "KAI: error sourcing `$PROFILE: $_"
    }
}

# Capture whatever prompt the user's profile defined (Oh-My-Posh, Starship,
# posh-git, or the default) so we can wrap it with OSC markers.
if (Test-Path Function:prompt) {
    Copy-Item Function:prompt Function:__KAI_user_prompt -Force -ErrorAction SilentlyContinue
}

function global:__KAI_urlencode {
    param([string]$s)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
    $sb = [System.Text.StringBuilder]::new($bytes.Length)
    foreach ($b in $bytes) {
        if (($b -ge 0x30 -and $b -le 0x39) -or
            ($b -ge 0x41 -and $b -le 0x5A) -or
            ($b -ge 0x61 -and $b -le 0x7A) -or
            $b -eq 0x2F -or $b -eq 0x2E -or $b -eq 0x5F -or
            $b -eq 0x7E -or $b -eq 0x2D) {
            [void]$sb.Append([char]$b)
        } else {
            [void]$sb.AppendFormat('%{0:X2}', $b)
        }
    }
    $sb.ToString()
}

function global:prompt {
    $lec = $LASTEXITCODE
    if ($null -eq $lec) { $lec = if ($?) { 0 } else { 1 } }
    $esc = [char]27

    # If the cursor is not at column 0 (e.g. a server process exited without a
    # trailing newline), print a newline so the prompt doesn't overwrite the
    # last line of output. The dim "%" marker matches the convention used by
    # zsh's PROMPT_CR / PROMPT_SP — it signals the partial line visually.
    try {
        if ([Console]::CursorLeft -ne 0) {
            $cols = [Console]::WindowWidth
            if ($cols -le 0) { $cols = 80 }
            $marker = "$esc[7m%$esc[0m"
            $pad = $cols - [Console]::CursorLeft - 1
            if ($pad -gt 0) { Write-Host (' ' * $pad) -NoNewline }
            Write-Host $marker -NoNewline
            Write-Host "`r`n" -NoNewline
        }
    } catch {}

$oscD = "$esc]133;D;$lec$esc\"
$oscA = "$esc]133;A$esc\"
$oscB = "$esc]133;B$esc\"

$loc = Get-Location
$osc7 = ''
if ($loc.Provider.Name -eq 'FileSystem') {
    $cwd = $loc.ProviderPath -replace '\\','/'
    if ($cwd -match '^[A-Za-z]:') { $cwd = "/$cwd" }
    $cwdEnc = __KAI_urlencode $cwd
    $hostName = [System.Environment]::MachineName
    $osc7 = "$esc]7;file://$hostName$cwdEnc$esc\"
}

$original = if (Test-Path Function:__KAI_user_prompt) {
    try { & __KAI_user_prompt } catch { "PS $((Get-Location).Path)> " }
} else {
    "PS $((Get-Location).Path)> "
}

$global:LASTEXITCODE = $lec
"$oscD$oscA$osc7${original}${oscB}"
}

# OSC 133 C — a submitted line is ACTUALLY EXECUTING (2026-11-02
# phantom-green-dot fix). B above marks the prompt LINE for command-text
# extraction and fires at every prompt render, so the host deliberately does
# NOT light the "terminal running" dot on B. This wrapper emits C when the
# user submits a NON-EMPTY line — Windows parity with zsh preexec / bash PS0
# (neither fires for an empty Enter, and neither should we: the dot must not
# blink on empty prompts).
if (-not (Test-Path Function:__KAI_original_Readline)) {
    try {
        Copy-Item Function:PSConsoleHostReadLine Function:__KAI_original_Readline -Force -ErrorAction SilentlyContinue
    } catch {}
}
if (Test-Path Function:__KAI_original_Readline) {
    function global:PSConsoleHostReadLine {
        $line = __KAI_original_Readline
        if ($null -ne $line -and "$line".Trim().Length -gt 0) {
            $esc = [char]27
            try { [Console]::Out.Write("$esc]133;C$esc\") } catch {}
        }
        $line
    }
}
