const fs = require('fs');
let yml = fs.readFileSync('.github/workflows/paperclip-ci.yml', 'utf8');

const search = `      - name: Start Disposable Paperclip Server
        run: |
          docker run -d -p 3100:3100 --name paperclip-ci-server ghcr.io/paperclipai/paperclip-server:latest
          sleep 10`;

const replace = `      - name: Start Disposable Paperclip Server
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          echo $GITHUB_TOKEN | docker login ghcr.io -u \${{ github.actor }} --password-stdin
          docker run -d -p 3100:3100 --name paperclip-ci-server ghcr.io/paperclipai/paperclip-server:latest
          sleep 10`;

yml = yml.replace(search, replace);
fs.writeFileSync('.github/workflows/paperclip-ci.yml', yml);
