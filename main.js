const { BrowserWindow, BrowserView, ipcMain, app, clipboard, dialog } = require('electron');
const path = require('path');
const isDev = require("electron-is-dev");
const EventEmitter = require('events');
const log = require('electron-log');
const axios = require('axios');

let homePage = "https://www.google.lk/";
let hostPlace = "http://moraphishdet.projects.uom.lk";

log.transports.file.level = false;
log.transports.console.level = false;

const electron = require('electron');
const Menu = electron.Menu || electron.remote.Menu;
const MenuItem = electron.MenuItem || electron.remote.MenuItem;

/**
* @typedef {number} TabID
* @description BrowserView's id as tab id
*/

/**
* @typedef {object} Tab
* @property {string} url - tab's url(address bar)
* @property {string} href - tab's loaded page url(location.href)
* @property {string} title - tab's title
* @property {string} t_status - tab's title status(verify or loading)
* @property {string} target_url - update when mouse moves over a link or the keyboard moves the focus to a link
* @property {int} mpd_action - moraphishdet action
* @property {int} mpd_record - moraphishdet record
* @property {string} favicon - tab's favicon url
* @property {boolean} isLoading
* @property {boolean} canGoBack
* @property {boolean} canGoForward
*/

/**
* @typedef {Object.<TabID, Tab>} Tabs
*/

/**
* @typedef {object} Bounds
* @property {number} x
* @property {number} y
* @property {number} width
* @property {number} height
*/

/**
* A browser like window
* @param {object} options
* @param {number} [options.width = 1366] - browser window's width
* @param {number} [options.height = 768] - browser window's height
* @param {string} options.controlPanel - control interface path to load
* @param {number} [options.controlHeight = 130] - control interface's height
* @param {object} [options.viewReferences] - webReferences for every BrowserView
* @param {object} [options.controlReferences] - webReferences for control panel BrowserView
* @param {object} [options.winOptions] - options for BrowserWindow
* @param {string} [options.startPage = ''] - start page to load on browser open
* @param {string} [options.blankPage = ''] - blank page to load on new tab
* @param {string} [options.blankTitle = 'about:blank'] - blank page's title
* @param {function} [options.onNewWindow] - custom webContents `new-window` event handler
* @param {boolean} [options.debug] - toggle debug
*/
class BrowserLikeWindow extends EventEmitter {
  constructor(options) {
    super();

    this.options = options;
    const {
      width = 1366,
      height = 768,
      winOptions = {title:'MORA Browser -- Feel Safe from Phishing'},
      controlPanel,
      controlReferences
    } = options;

    this.win = new BrowserWindow({
      ...winOptions,
      width,
      height
    });

    this.defCurrentViewId = null;
    this.defTabConfigs = {};
    // Prevent browser views garbage collected
    this.views = {};
    // keep order
    this.tabs = [];
    // ipc channel
    this.ipc = null;

    this.controlView = new BrowserView({
      webPreferences: {
        nodeIntegration: true,
        enableRemoteModule: true,
        // Allow loadURL with file path in dev environment
        webSecurity: false,
        ...controlReferences
      }
    });

    // BrowserView should add to window before setup
    this.win.addBrowserView(this.controlView);
    this.win.setMenuBarVisibility(false);
    this.controlView.setBounds(this.getControlBounds());
    this.controlView.setAutoResize({ width: true });
    this.controlView.webContents.loadURL(controlPanel);

    const webContentsAct = actionName => {
      const webContents = this.currentWebContents;
      const action = webContents && webContents[actionName];
      if (typeof action === 'function') {
        if (actionName === 'reload' && webContents.getURL() === '') return;
        action.call(webContents);
        log.debug(
          `do webContents action ${actionName} for ${this.currentViewId}:${webContents &&
            webContents.getTitle()}`
          );
        } else {
          log.error('Invalid webContents action ', actionName);
        }
      };

      const channels = Object.entries({
        'control-ready': e => {
          this.ipc = e;

          this.newTab(this.options.startPage || '');
          /**
          * control-ready event.
          *
          * @event BrowserLikeWindow#control-ready
          * @type {IpcMainEvent}
          */
          this.emit('control-ready', e);
        },
        'url-change': (e, url) => {
          this.setTabConfig(this.currentViewId, { url });
        },
        'url-enter': (e, url) => {
          this.loadURL(url, false);
        },
        act: (e, actName) => webContentsAct(actName),
        'new-tab': (e, url, references) => {
          log.debug('new-tab with url', url);
          this.newTab(url, undefined, false, references);
        },
        'switch-tab': (e, id) => {
          this.switchTab(id);
        },
        'close-tab': (e, id) => {
          log.debug('close tab ', { id, currentViewId: this.currentViewId });
          if (id === this.currentViewId) {
            const removeIndex = this.tabs.indexOf(id);
            const nextIndex = removeIndex === this.tabs.length - 1 ? 0 : removeIndex + 1;
            this.setCurrentView(this.tabs[nextIndex]);
          }
          this.tabs = this.tabs.filter(v => v !== id);
          this.tabConfigs = {
            ...this.tabConfigs,
            [id]: undefined
          };
          this.destroyView(id);

          if (this.tabs.length === 0) {
            this.newTab();
          }
        }
      });

      channels
      .map(([name, listener]) => [
        name,
        (e, ...args) => {
          // Support multiple BrowserLikeWindow
          if (this.controlView && e.sender === this.controlView.webContents) {
            log.debug(`Trigger ${name} from ${e.sender.id}`);
            listener(e, ...args);
          }
        }
      ])
      .forEach(([name, listener]) => ipcMain.on(name, listener));

      /**
      * closed event
      *
      * @event BrowserLikeWindow#closed
      */
      this.win.on('closed', () => {
        // Remember to clear all ipcMain events as ipcMain bind
        // on every new browser instance
        channels.forEach(([name, listener]) => ipcMain.removeListener(name, listener));

        // Prevent BrowserView memory leak on close
        this.tabs.forEach(id => this.destroyView(id));
        if (this.controlView) {
          this.controlView.destroy();
          this.controlView = null;
          log.debug('Control view destroyed');
        }
        this.emit('closed');
      });

      if (this.options.debug) {
        this.controlView.webContents.openDevTools({ mode: 'detach' });
        log.transports.console.level = 'debug';
      }
    }

    /**
    * Get control view's bounds
    *
    * @returns {Bounds} Bounds of control view(exclude window's frame)
    */
    getControlBounds() {
      const contentBounds = this.win.getContentBounds();
      return {
        x: 0,
        y: 0,
        width: contentBounds.width,
        height: this.options.controlHeight || 130
      };
    }

    /**
    * Set web contents view's bounds automatically
    * @ignore
    */
    setContentBounds() {
      const [contentWidth, contentHeight] = this.win.getContentSize();
      const controlBounds = this.getControlBounds();
      if (this.currentView) {
        this.currentView.setBounds({
          x: 0,
          y: controlBounds.y + controlBounds.height,
          width: contentWidth,
          height: contentHeight - controlBounds.height
        });
      }
    }

    get currentView() {
      return this.currentViewId ? this.views[this.currentViewId] : null;
    }

    get currentWebContents() {
      const { webContents } = this.currentView || {};
      return webContents;
    }

    // The most important thing to remember about the get keyword is that it defines an accessor property,
    // rather than a method. So, it can’t have the same name as the data property that stores the value it accesses.
    get currentViewId() {
      return this.defCurrentViewId;
    }

    set currentViewId(id) {
      this.defCurrentViewId = id;
      this.setContentBounds();
      if (this.ipc) {
        this.ipc.reply('active-update', id);
      }
    }

    get tabConfigs() {
      return this.defTabConfigs;
    }

    set tabConfigs(v) {
      this.defTabConfigs = v;
      if (this.ipc) {
        this.ipc.reply('tabs-update', {
          confs: v,
          tabs: this.tabs
        });
      }
    }

    setTabConfig(viewId, kv) {
      const tab = this.tabConfigs[viewId];
      const { webContents } = this.views[viewId] || {};
      this.tabConfigs = {
        ...this.tabConfigs,
        [viewId]: {
          ...tab,
          canGoBack: webContents && webContents.canGoBack(),
          canGoForward: webContents && webContents.canGoForward(),
          ...kv
        }
      };
      return this.tabConfigs;
    }

    async MORAPhishDet(url){
      //console.log("MORAPhishDet --> " + url);
      let res = await axios.post(hostPlace + ':5000/moraphishdet', {url: url});

      if (res.status === 200){
        return new Array(res.data.action, res.data.id);
      }
      else{
        console.log(`Status text: ${res.statusText}`);
      }
      //console.log(`Status text: ${res.statusText}`);
      //console.log(`Request method: ${res.request.method}`);
      //alert(`Path: ${res.request.path}`);
      //console.log(`Date: ${res.headers.date}`);
    }

    async UpdateUserAction(id){
      //console.log("MORAPhishDet --> " + url);
      let res = await axios.post(hostPlace + ':5000/moraphishup', {id: id});

      if (res.status === 200){
        console.log('record updated');
      }
      else{
        console.log(`Status text: ${res.statusText}`);
      }
      //console.log(`Status text: ${res.statusText}`);
      //console.log(`Request method: ${res.request.method}`);
      //alert(`Path: ${res.request.path}`);
      //console.log(`Date: ${res.headers.date}`);
    }

    loadURL(url, checkByPass) {
      const { currentView } = this;
      if (!url || !currentView) return;

      const { id, webContents } = currentView;

      if(checkByPass === true){
        this.setTabConfig(id, { mpd_action: 0, mpd_record: 0 });
      }

      // Prevent addEventListeners on same webContents when enter urls in same tab
      const MARKS = '__IS_INITIALIZED__';
      if (webContents[MARKS]) {
        this.checkRequestedPage(webContents, id, url);
        //webContents.loadURL(url);
        return;
      }

      const onNewWindow = (e, newUrl, frameName, disposition, winOptions) => {
        log.debug('on new-window', { disposition, newUrl, frameName });

        if (!new URL(newUrl).host) {
          // Handle newUrl = 'about:blank' in some cases
          log.debug('Invalid url open with default window');
          return;
        }

        e.preventDefault();

        if (disposition === 'new-window') {
          e.newGuest = new BrowserWindow(winOptions);
        } else if (disposition === 'foreground-tab') {
          this.newTab(newUrl, id);
          // `newGuest` must be setted to prevent freeze trigger tab in case.
          // The window will be destroyed automatically on trigger tab closed.
          e.newGuest = new BrowserWindow({ ...winOptions, show: false });
        } else {
          this.newTab(newUrl, id);
        }
      };

      webContents.on('new-window', this.options.onNewWindow || onNewWindow);

      // Keep event in order
      webContents
      .on('did-start-loading', () => {
        log.debug('did-start-loading > set loading');
        this.setTabConfig(id, { isLoading: true});
      })
      .on('will-navigate', (e, href) => {
        var lp = href.split('/').pop().split('#');
        var from_local_button = (lp[0] === "moraapp-local-btn-clicked") ? true : false;
        if (from_local_button){
          var navLocation = (lp[1] === "mora-home") ? "https://uom.lk" : ((lp[1] === "uni-home") ? "https://uom.lk" : homePage);

          if (lp[1] === "ignore"){
            navLocation = this.tabConfigs[lp[2]]['url'];
          }

          if (lp[1] === "trust"){
            navLocation = this.tabConfigs[lp[2]]['url'];
            this.UpdateUserAction(this.tabConfigs[lp[2]]['mpd_record']);
          }
          this.setTabConfig(id, { t_status: "loading", mpd_action: 0, mpd_record: 0 });
          this.getPhishingPage(id, navLocation);
        }
        else if (href === this.tabConfigs[id]['target_url']){
          this.currentWebContents._stop();
          this.checkRequestedPage(webContents, id, href);
        }
        else{
          //pass
        }
      })
      .on('will-redirect', (e, href) => {
        if(this.tabConfigs[id]['mpd_action'] === 0 || this.tabConfigs[id]['mpd_action'] === -1){
          href = href;
        }
        else{
          href = this.tabConfigs[id]['url'];
        }

        log.debug('will-redirect > update url address', { href });
        this.setTabConfig(id, { url: href, href });
        this.emit('url-updated', { view: currentView, href });
      })
      .on('page-title-updated', (e, title) => {
        log.debug('page-title-updated', title);
        this.setTabConfig(id, { title });
      })
      .on('update-target-url', (e, url) => {
        this.setTabConfig(id, { target_url: url });
      })
      .on('page-favicon-updated', (e, favicons) => {
        log.debug('page-favicon-updated', favicons);
        this.setTabConfig(id, { favicon: favicons[0] });
      })
      .on('did-stop-loading', () => {
        log.debug('did-stop-loading', { title: webContents.getTitle() });
        this.setTabConfig(id, { isLoading: false });
      })
      .on('context-menu', (e, params) => {
        var self = this;
        const menu = new Menu();
        if(params.linkURL){
          menu.append(new MenuItem({ label: 'Open Link in New Tab', click() { self.newTab(params.linkURL, id) } }));
          menu.append(new MenuItem({ label: 'Copy Link Address', click() { clipboard.writeText(params.linkURL) } }));
        }
        else{
          menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
          menu.append(new MenuItem({ label: 'Select All', role: 'selectAll' }));
          menu.append(new MenuItem({ label: 'Save Page As...', click() {
            const options = {defaultPath: app.getPath('documents') ,}
            const saveDialog = dialog.showSaveDialog(null, options);
            saveDialog.then(function(saveTo) {
              webContents.savePage(saveTo.filePath, 'HTMLComplete');
            }); }
          }));
          menu.append(new MenuItem({ type: 'separator' }));
          menu.append(new MenuItem({ label: 'Zoom In', role: 'zoomIn' }));
          menu.append(new MenuItem({ label: 'Zoom Out', role: 'zoomOut' }));
          menu.append(new MenuItem({ label: 'Reset Zoom', role: 'resetZoom' }));
          menu.append(new MenuItem({ type: 'separator' }));
          menu.append(new MenuItem({ label: 'Inspect Element', click() { webContents.openDevTools() } }));
        }

        menu.popup(webContents, params.x, params.y);
      })
      .on('dom-ready', () => {
        webContents.focus();
        if(this.tabConfigs[id]['mpd_action'] === 0 || this.tabConfigs[id]['mpd_action'] === -1){
          this.setTabConfig(id, { url: webContents.getURL() });
        }
      });

      if (url != undefined && (checkByPass === false || checkByPass === undefined)){
        this.checkRequestedPage(webContents, id, url);
      }
      else{
        this.getPhishFreeView(webContents, id, url, new Array(0, 0));
      }

      webContents[MARKS] = true;

      this.setContentBounds();

      if (this.options.debug) {
        webContents.openDevTools({ mode: 'detach' });
      }
    }

    setCurrentView(viewId) {
      if (!viewId) return;
      this.win.removeBrowserView(this.currentView);
      this.win.addBrowserView(this.views[viewId]);
      this.currentViewId = viewId;
    }

    checkRequestedPage(webContents, id, url){
      this.setTabConfig(id, { isLoading: true, t_status: "verifying" });
      this.MORAPhishDet(url).then(results => {
        this.setTabConfig(id, { mpd_action: results[0], mpd_record: results[1] });
        this.getPhishFreeView(webContents, id, url, results);
        //console.log(this.tabConfigs[id]['mpd_action']);
        //console.log(this.tabConfigs[id]['mpd_record']);
      });
    }

    getPhishFreeView(webContents, id, url, results){
      this.setTabConfig(id, { t_status: "loading" });
      switch(results[0]) {
        case 0:
        webContents.loadURL(url);
        break;
        case 1:
        webContents.loadURL(hostPlace + "/smartiphish/site/deceptive-site.php?id=" + id);
        this.setTabConfig(id, { url: url, href: url });
        break;
        case 2:
        webContents.loadURL(hostPlace + "/smartiphish/site/user-select.php?id=" + id);
        this.setTabConfig(id, { url: url, href: url });
        break;
        case 3:
        webContents.loadURL(hostPlace + "/smartiphish/site/service-error.php?id=" + id);
        this.setTabConfig(id, { url: url, href: url });
        break;
        case 4:
        webContents.loadURL(hostPlace + "/smartiphish/site/redirection-attempt.php?id=" + id);
        this.setTabConfig(id, { url: url, href: url });
        break;
        case -1:
        webContents.loadURL(url);
        break;
        default:
        // code block
      }
    }

    getPhishingPage(id, url){
      if (id === this.currentViewId) {
        const removeIndex = this.tabs.indexOf(id);
        const nextIndex = removeIndex === this.tabs.length - 1 ? 0 : removeIndex + 1;
        this.setCurrentView(this.tabs[nextIndex]);
      }
      this.tabs = this.tabs.filter(v => v !== id);
      this.tabConfigs = {
        ...this.tabConfigs,
        [id]: undefined
      };
      this.destroyView(id);
      this.newTab(url, undefined, true);
    }

    /**
    * Create a tab
    *
    * @param {string} [url=this.options.blankPage]
    * @param {number} [appendTo] - add next to specified tab's id
    * @param {boolean} [checkByPass=false] - custom parameter to check whether MORAPhishDet need to bypass
    * @param {object} [references=this.options.viewReferences] - custom webPreferences to this tab
    *
    * @fires BrowserLikeWindow#new-tab
    */
    newTab(url, appendTo, checkByPass, references) {
      const view = new BrowserView({
        webPreferences: {
          // Set sandbox to support window.opener
          // See: https://github.com/electron/electron/issues/1865#issuecomment-249989894
          sandbox: true,
          ...(references || this.options.viewReferences)
        }
      });

      if (appendTo) {
        const prevIndex = this.tabs.indexOf(appendTo);
        this.tabs.splice(prevIndex + 1, 0, view.id);
      } else {
        this.tabs.push(view.id);
      }
      this.views[view.id] = view;

      // Add to manager first
      const lastView = this.currentView;
      this.setCurrentView(view.id);
      view.setAutoResize({ width: true, height: true });
      this.loadURL(url || this.options.blankPage, checkByPass);
      this.setTabConfig(view.id, {
        title: this.options.blankTitle || 'about:blank'
      });
      /**
      * new-tab event.
      *
      * @event BrowserLikeWindow#new-tab
      * @return {BrowserView} view - current browser view
      * @return {string} [source.openedURL] - opened with url
      * @return {BrowserView} source.lastView - previous active view
      */
      this.emit('new-tab', view, { openedURL: url, lastView });
      return view;
    }

    /**
    * Swith to tab
    * @param {TabID} viewId
    */
    switchTab(viewId) {
      log.debug('switch to tab', viewId);
      this.setCurrentView(viewId);
      this.currentView.webContents.focus();
    }

    /**
    * Destroy tab
    * @param {TabID} viewId
    * @ignore
    */
    destroyView(viewId) {
      const view = this.views[viewId];
      if (view) {
        view.destroy();
        this.views[viewId] = undefined;
        log.debug(`${viewId} destroyed`);
      }
    }
  }

  let browser;

  function createWindow() {
    browser = new BrowserLikeWindow({
      controlHeight: 99,
      controlPanel: isDev ? "http://localhost:3000" : `file://${path.join(__dirname, "build/index.html")}`,
      startPage: homePage,
      blankTitle: 'New tab'
      //debug: true // will open controlPanel's devtools
    });

    browser.on('closed', () => {
      browser = null;
    });
  }

  app.on('ready', async () => {
    createWindow();
  });

  // Quit when all windows are closed.
  app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (browser === null) {
      createWindow();
    }
  });
