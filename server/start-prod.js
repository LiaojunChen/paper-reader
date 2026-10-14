// Serve the built client (browser mode, no Electron)
process.env.NODE_ENV = 'production';
await import('./index.js');
