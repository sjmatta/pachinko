import { defineConfig } from 'vite'

export default defineConfig({
	// Relative base so the same build drops straight into an Electron `file://`
	// load (Steam Deck) or a Capacitor WKWebView bundle (iOS) with no rewriting.
	base: './',
	server: { host: '127.0.0.1', port: 5173 },
	build: {
		target: 'es2022',
		sourcemap: true,
	},
})
