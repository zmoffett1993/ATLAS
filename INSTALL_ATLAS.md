# Install ATLAS

Upload `index.html`, `manifest.webmanifest`, `service-worker.js`, and the complete
`icons` folder to the root of the ATLAS GitHub repository. Keep the filenames
and folder structure exactly as provided.

## Install on iPhone

1. Open the ATLAS GitHub Pages link in Safari.
2. Tap **Share**.
3. Tap **Add to Home Screen**.
4. Turn on **Open as Web App**.
5. Tap **Add**.

## Install on Android

1. Open the ATLAS link in Chrome.
2. Open the browser menu.
3. Tap **Install app** or **Add to Home screen**.
4. Confirm the installation.

## Offline behavior

After ATLAS has loaded successfully online at least once, employees can reopen
the app and view the most recently downloaded SKU and location data during an
internet outage. ATLAS clearly marks this state as offline and prevents
inventory changes until the connection returns.

## Publishing future updates

Replace the changed files in GitHub as usual. When changing cached application
files, update the `VERSION` value near the top of `service-worker.js` so
installed phones download the new release.
