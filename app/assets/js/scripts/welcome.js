/**
 * Script for welcome.ejs
 */
document.getElementById('welcomeButton').addEventListener('click', e => {
    // Straight to the pseudo screen, nothing to cancel back to.
    showLoginView(VIEWS.landing, VIEWS.login, false)
})