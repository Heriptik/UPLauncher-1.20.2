/**
 * Core UI functions are initialized in this file. This prevents
 * unexpected errors from breaking the core features. Specifically,
 * actions in this file should not require the usage of any internal
 * modules, excluding dependencies.
 */
// Requirements
const $                              = require('jquery')
const {ipcRenderer, shell, webFrame} = require('electron')
const remote                         = require('@electron/remote')
const isDev                          = require('./assets/js/isdev')
const { LoggerUtil }                 = require('helios-core')
const Lang                           = require('./assets/js/langloader')

const loggerUICore             = LoggerUtil.getLogger('UICore')
const loggerAutoUpdater        = LoggerUtil.getLogger('AutoUpdater')

// Log deprecation and process warnings.
process.traceProcessWarnings = true
process.traceDeprecation = true

// Silence DEP0190 only: the winreg library (used by helios-core to find Java
// in the Windows registry) spawns reg.exe in a way Node now deprecates. Its
// latest release still does so and the Java lookup works, so this is noise.
const emitProcessWarning = process.emitWarning
process.emitWarning = function(warning, ...args){
    const code = (warning != null && warning.code)
        || (args[0] != null && typeof args[0] === 'object' ? args[0].code : args[1])
    if(code === 'DEP0190'){
        return
    }
    return emitProcessWarning.call(process, warning, ...args)
}

// Disable eval function.
// eslint-disable-next-line
window.eval = global.eval = function () {
    throw new Error('Sorry, this app does not support window.eval().')
}

// Display warning when devtools window is opened.
remote.getCurrentWebContents().on('devtools-opened', () => {
    console.log('%cThe console is dark and full of terrors.', 'color: white; -webkit-text-stroke: 4px #a02d2a; font-size: 60px; font-weight: bold')
    console.log('%cIf you\'ve been told to paste something here, you\'re being scammed.', 'font-size: 16px')
    console.log('%cUnless you know exactly what you\'re doing, close this window.', 'font-size: 16px')
})

// Disable zoom, needed for darwin.
webFrame.setZoomLevel(0)
// Zoom out when the window had to be shrunk to fit the screen (see index.js).
const fitZoom = Math.min(1, remote.getCurrentWindow().getContentSize()[0] / 1280)
if(fitZoom < 1){
    webFrame.setZoomFactor(fitZoom)
}
webFrame.setVisualZoomLevelLimits(1, 1)

// Mandatory update (Windows only). An update found by the first check at
// startup takes over the window, downloads, installs silently and reopens the
// launcher. Any failure releases the window so the player is never locked out.
const FORCED_UPDATE_KEY = 'ulForcedUpdateAttempt'
const LAUNCH_AFTER_UPDATE_KEY = 'ulLaunchAfterUpdate'
const LAUNCH_AFTER_UPDATE_MAX_AGE = 300000
const FORCED_UPDATE_STALL = 60000
const FORCED_UPDATE_INSTALL_WAIT = 20000
let forcedUpdateActive = false
let forcedUpdateTimer = null
let firstUpdateCheckDone = false
// Update known to exist but not installed yet, and whether its installer is ready.
let pendingUpdate = null
let pendingUpdateDownloaded = false
// Set once the mandatory update failed in this session: never ask twice.
let forcedUpdateFailed = false
// When the update was started by the play button: what to do if it fails.
let forcedUpdateFallback = null

function getForcedUpdateAttempt(){
    try {
        return localStorage.getItem(FORCED_UPDATE_KEY)
    } catch(err) {
        return null
    }
}

function setForcedUpdateAttempt(version){
    try {
        if(version == null){
            localStorage.removeItem(FORCED_UPDATE_KEY)
        } else {
            localStorage.setItem(FORCED_UPDATE_KEY, version)
        }
    } catch(err) {
        // Storage unavailable: the update simply stays optional next time.
    }
}

function armForcedUpdateTimer(delay){
    clearTimeout(forcedUpdateTimer)
    forcedUpdateTimer = setTimeout(() => {
        loggerAutoUpdater.warn('Mandatory update is taking too long, letting the player in.')
        releaseForcedUpdate()
    }, delay)
}

function shouldForceUpdate(info){
    if(process.platform !== 'win32' || firstUpdateCheckDone || forcedUpdateActive){
        return false
    }
    // This version was already tried and we are still on the old one: do not loop.
    if(info == null || info.version == null || getForcedUpdateAttempt() === info.version){
        return false
    }
    // Never interrupt a game that is being launched.
    const launchButton = document.getElementById('launch_button')
    return launchButton == null || !launchButton.hasAttribute('launching')
}

function startForcedUpdate(info){
    loggerAutoUpdater.info('Mandatory update', info.version)
    forcedUpdateActive = true
    document.body.setAttribute('ul-updating', '')
    document.getElementById('updateGate').style.display = 'block'
    armForcedUpdateTimer(FORCED_UPDATE_STALL)
}

function forcedUpdateProgress(percent){
    const value = Math.max(0, Math.min(100, Math.round(percent || 0)))
    document.getElementById('updateGateFill').style.width = value + '%'
    document.getElementById('updateGateText').innerHTML = Lang.queryJS('uicore.forcedUpdate.downloading', { percent: value })
    armForcedUpdateTimer(FORCED_UPDATE_STALL)
}

function releaseForcedUpdate(){
    if(!forcedUpdateActive){
        return
    }
    forcedUpdateActive = false
    forcedUpdateFailed = true
    clearTimeout(forcedUpdateTimer)
    document.body.removeAttribute('ul-updating')
    document.getElementById('updateGate').style.display = 'none'
    try {
        localStorage.removeItem(LAUNCH_AFTER_UPDATE_KEY)
    } catch(err) {
        // Nothing to clean.
    }
    const fallback = forcedUpdateFallback
    forcedUpdateFallback = null
    if(fallback != null){
        fallback()
    }
}

function installForcedUpdate(version){
    setForcedUpdateAttempt(version)
    if(forcedUpdateFallback != null){
        // Started from the play button: launch the game once the launcher is back.
        try {
            localStorage.setItem(LAUNCH_AFTER_UPDATE_KEY, String(Date.now()))
        } catch(err) {
            // The player will simply have to press play again.
        }
    }
    document.getElementById('updateGateFill').style.width = '100%'
    document.getElementById('updateGateText').innerHTML = Lang.queryJS('uicore.forcedUpdate.installing')
    // If the launcher is still open after this delay, the install did not start.
    armForcedUpdateTimer(FORCED_UPDATE_INSTALL_WAIT)
    ipcRenderer.send('autoUpdateAction', 'installUpdateNow', true)
}

/**
 * Called by the play button. If a launcher update is waiting, install it
 * first; the game is launched automatically once the launcher has restarted.
 *
 * @param {Function} fallback Called if the update fails, to launch the game anyway.
 * @returns {boolean} True if the update took over, false to launch right away.
 */
function requestUpdateBeforeLaunch(fallback){
    if(process.platform !== 'win32' || pendingUpdate == null || forcedUpdateActive || forcedUpdateFailed){
        return false
    }
    if(getForcedUpdateAttempt() === pendingUpdate.version){
        return false
    }
    startForcedUpdate(pendingUpdate)
    forcedUpdateFallback = fallback
    if(pendingUpdateDownloaded){
        installForcedUpdate(pendingUpdate.version)
    }
    return true
}

/**
 * @returns {boolean} True if the launcher just restarted after an update
 * that was started by the play button.
 */
function consumeLaunchAfterUpdate(){
    try {
        const stamp = parseInt(localStorage.getItem(LAUNCH_AFTER_UPDATE_KEY), 10)
        localStorage.removeItem(LAUNCH_AFTER_UPDATE_KEY)
        return !isNaN(stamp) && Date.now() - stamp < LAUNCH_AFTER_UPDATE_MAX_AGE
    } catch(err) {
        return false
    }
}

// Logo shine and sparkles, played in short bursts (see ultra.css) and only
// while the launcher is the window in use: nothing runs behind the game.
const LOGO_SPARKLE_EVERY = 5000
const LOGO_SPARKLE_LENGTH = 3800

function playLogoSparkle(){
    if(document.visibilityState !== 'visible' || !document.hasFocus()){
        return
    }
    const logos = Array.from(document.getElementsByClassName('ulLogo'))
    logos.forEach(logo => logo.classList.add('ul-sparkle'))
    setTimeout(() => {
        logos.forEach(logo => logo.classList.remove('ul-sparkle'))
    }, LOGO_SPARKLE_LENGTH)
}

/**
 * Play the logo effect once now, then at a regular interval. Called by
 * uibinder.js when the interface has finished its opening sequence.
 */
let logoSparkleStarted = false
function startLogoSparkle(){
    if(logoSparkleStarted){
        return
    }
    logoSparkleStarted = true
    playLogoSparkle()
    setInterval(playLogoSparkle, LOGO_SPARKLE_EVERY)
}

// Initialize auto updates in production environments.
let updateCheckListener
if(!isDev){
    ipcRenderer.on('autoUpdateNotification', (event, arg, info) => {
        switch(arg){
            case 'checking-for-update':
                loggerAutoUpdater.info('Checking for update..')
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkingForUpdateButton'), true)
                break
            case 'update-available':
                loggerAutoUpdater.info('New update available', info.version)

                if(process.platform === 'darwin'){
                    info.darwindownload = `https://github.com/dscalzi/HeliosLauncher/releases/download/v${info.version}/Helios-Launcher-setup-${info.version}${process.arch === 'arm64' ? '-arm64' : '-x64'}.dmg`
                }
                showUpdateUI(info)

                populateSettingsUpdateInformation(info)
                if(pendingUpdate == null || pendingUpdate.version !== info.version){
                    pendingUpdateDownloaded = false
                }
                pendingUpdate = info
                if(shouldForceUpdate(info)){
                    startForcedUpdate(info)
                }
                firstUpdateCheckDone = true
                break
            case 'download-progress':
                settingsUpdateProgress(info != null ? info.percent : null)
                if(forcedUpdateActive && info != null){
                    forcedUpdateProgress(info.percent)
                }
                break
            case 'update-downloaded':
                loggerAutoUpdater.info('Update ' + info.version + ' ready to be installed.')
                settingsUpdateProgress(null)
                pendingUpdate = info
                pendingUpdateDownloaded = true
                if(forcedUpdateActive){
                    installForcedUpdate(info.version)
                }
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.installNowButton'), false, () => {
                    if(!isDev){
                        ipcRenderer.send('autoUpdateAction', 'installUpdateNow')
                    }
                })
                showUpdateUI(info)
                break
            case 'update-not-available':
                loggerAutoUpdater.info('No new update found.')
                firstUpdateCheckDone = true
                setForcedUpdateAttempt(null)
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkForUpdatesButton'))
                break
            case 'ready':
                updateCheckListener = setInterval(() => {
                    ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
                }, 1800000)
                ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
                break
            case 'realerror':
                firstUpdateCheckDone = true
                releaseForcedUpdate()
                if(info != null && info.code != null){
                    if(info.code === 'ERR_UPDATER_INVALID_RELEASE_FEED'){
                        loggerAutoUpdater.info('No suitable releases found.')
                    } else if(info.code === 'ERR_XML_MISSED_ELEMENT'){
                        loggerAutoUpdater.info('No releases found.')
                    } else {
                        loggerAutoUpdater.error('Error during update check..', info)
                        loggerAutoUpdater.debug('Error Code:', info.code)
                    }
                }
                break
            default:
                loggerAutoUpdater.info('Unknown argument', arg)
                break
        }
    })
}

/**
 * Send a notification to the main process changing the value of
 * allowPrerelease. If we are running a prerelease version, then
 * this will always be set to true, regardless of the current value
 * of val.
 *
 * @param {boolean} val The new allow prerelease value.
 */
function changeAllowPrerelease(val){
    ipcRenderer.send('autoUpdateAction', 'allowPrereleaseChange', val)
}

function showUpdateUI(info){
    //TODO Make this message a bit more informative `${info.version}`
    document.getElementById('updateIconContainer').style.display = 'flex'
    document.getElementById('settingsNavUpdate').setAttribute('update', '')
    document.getElementById('updateIconContainer').onclick = async () => {
        // The settings tabs must be loaded first, otherwise saving on "back" fails.
        await prepareSettings()
        switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
            settingsNavItemListener(document.getElementById('settingsNavUpdate'), false)
        })
    }
}

/* jQuery Example
$(function(){
    loggerUICore.info('UICore Initialized');
})*/

document.addEventListener('readystatechange', function () {
    if (document.readyState === 'interactive'){
        loggerUICore.info('UICore Initializing..')

        // Bind close button.
        Array.from(document.getElementsByClassName('fCb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                window.close()
            })
        })

        // Bind restore down button.
        Array.from(document.getElementsByClassName('fRb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                if(window.isMaximized()){
                    window.unmaximize()
                } else {
                    window.maximize()
                }
                document.activeElement.blur()
            })
        })

        // Bind minimize button.
        Array.from(document.getElementsByClassName('fMb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                window.minimize()
                document.activeElement.blur()
            })
        })

        // Remove focus from social media buttons once they're clicked.
        Array.from(document.getElementsByClassName('mediaURL')).map(val => {
            val.addEventListener('click', e => {
                document.activeElement.blur()
            })
        })

    } else if(document.readyState === 'complete'){

        //266.01
        //170.8
        //53.21
        // Bind progress bar length to length of bot wrapper
        //const targetWidth = document.getElementById("launch_content").getBoundingClientRect().width
        //const targetWidth2 = document.getElementById("server_selection").getBoundingClientRect().width
        //const targetWidth3 = document.getElementById("launch_button").getBoundingClientRect().width

    }

}, false)

/**
 * Open web links in the user's default browser.
 */
$(document).on('click', 'a[href^="http"]', function(event) {
    event.preventDefault()
    shell.openExternal(this.href)
})

/**
 * Opens DevTools window if you hold (ctrl + shift + i).
 * This will crash the program if you are using multiple
 * DevTools, for example the chrome debugger in VS Code.
 */
document.addEventListener('keydown', function (e) {
    if((e.key === 'I' || e.key === 'i') && e.ctrlKey && e.shiftKey){
        let window = remote.getCurrentWindow()
        window.toggleDevTools()
    }
})