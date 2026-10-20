import './styles.scss'

const path = location.pathname.replace(/\/$/, '') || '/'
if (path === '/' || path === '/vanilla') await import('./examples/vanilla-entry.js')
else if (path === '/vue') await import('./examples/vue-entry.js')
else if (path === '/react') await import('./examples/react-entry.js')
else await import('./main.js')
