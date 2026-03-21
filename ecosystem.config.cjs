const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-pages',
    script: 'src/index.js',
    cwd: path.join(os.homedir(), '.claude/skills/zylos-pages'),
    env: {
      NODE_ENV: 'production'
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    error_file: path.join(os.homedir(), 'zylos/components/pages/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/pages/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
