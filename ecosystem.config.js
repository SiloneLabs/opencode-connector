module.exports = {
  apps: [
    {
      name: "opencode",
      script: "/root/.opencode/bin/opencode",
      args: "serve --port 4096 --hostname 127.0.0.1 --print-logs",
      cwd: "/root/connector",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 1000,
      kill_timeout: 3000,
      env: {
        OPENCODE_CONFIG_CONTENT: "{}",
        PATH: "/root/.opencode/bin:/root/.bun/bin:/root/.nvm/versions/node/v24.14.1/bin:/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
    },
    {
      name: "connector",
      script: "/root/.bun/bin/bun",
      args: "run src/index.ts",
      cwd: "/root/connector",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      kill_timeout: 3000,
      env: {
        OPENCODE_SERVER_URL: "http://127.0.0.1:4096",
        BUN_INSTALL: "/root/.bun",
        PATH: "/root/connector/node_modules/.bin:/root/.bun/bin:/root/.opencode/bin:/root/.nvm/versions/node/v24.14.1/bin:/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
    },
  ],
};
