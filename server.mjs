// Local express server for development and puppeteer tests. Serves dist/.
import express from 'express';
import path from 'node:path';
import url from 'node:url';

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'dist');

export function startServer(port = Number(process.env.PORT ?? 8080)) {
  const app = express();
  app.use(express.static(root, {etag: false, maxAge: 0}));
  return new Promise(resolve => {
    const server = app.listen(port, () => {
      const {port: actual} = server.address();
      console.log(`serving ${root} at http://localhost:${actual}/`);
      resolve(server);
    });
  });
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  startServer();
}
