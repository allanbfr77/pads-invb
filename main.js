// Pads Igreja — aplicativo de desktop (Electron)
// Sobe o servidor e abre o player já com o áudio ligado, sem precisar clicar.
//   Desenvolvimento:  npm install --save-dev electron  &&  npm run app
//   Instalador:       npm install --save-dev electron-builder  &&  npm run dist
const { app, BrowserWindow, Menu, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const userData = app.getPath('userData');
const samplesDir = path.join(userData, 'samples');
fs.mkdirSync(samplesDir, { recursive: true });
process.env.PADS_DATA_DIR = userData;       // data.json, config.json e certificados
process.env.PADS_SAMPLES_DIR = samplesDir;  // pasta de samples editável pelo usuário

const PORT = process.env.PORT || 3000;
let win = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(() => {
    require('./server.js');

    // permite listar as saídas de áudio (nomes das placas)
    const ok = (p) => p === 'media' || p === 'audioCapture';
    session.defaultSession.setPermissionRequestHandler((_wc, p, cb) => cb(ok(p)));
    session.defaultSession.setPermissionCheckHandler((_wc, p) => ok(p));

    win = new BrowserWindow({
      width: 760, height: 940, title: 'Pads Igreja', backgroundColor: '#0e1116',
      webPreferences: { backgroundThrottling: false },
    });
    win.loadURL(`http://localhost:${PORT}/player?auto=1`);
    win.on('closed', () => { win = null; });

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'Pads',
        submenu: [
          { label: 'Abrir pasta de samples', click: () => shell.openPath(samplesDir) },
          { label: 'Abrir pasta de dados (config.json, data.json)', click: () => shell.openPath(userData) },
          { type: 'separator' },
          {
            label: 'Iniciar junto com o computador', type: 'checkbox',
            checked: app.getLoginItemSettings().openAtLogin,
            click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }),
          },
          { type: 'separator' },
          { role: 'reload', label: 'Recarregar' },
          { role: 'quit', label: 'Sair' },
        ],
      },
    ]));
  });

  app.on('window-all-closed', () => app.quit());
}
