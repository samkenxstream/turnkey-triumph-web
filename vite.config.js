const cssvariables = require("postcss-css-variables");
const autoprefixer = require("autoprefixer");
const flexbugsFixes = require("postcss-flexbugs-fixes");

const fs = require("fs");
const path = require("path");

const injectWebManifest = require("./scripts/build-plugins/manifest");
const injectServiceWorker = require("./scripts/build-plugins/service-worker");
// const legacyBuild = require("./scripts/build-plugins/legacy-build");

// we could also just import {version} from "../../package.json" where needed,
// but this won't work in the service worker yet as it is not transformed yet
// TODO: we should emit a chunk early on and then transform the asset again once we know all the other assets to cache
const version = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
const {defineConfig} = require("vite");
let polyfillSrc;
let polyfillRef;

export default {
    public: false,
    root: "src/platform/web",
    base: "./",
    server: {
        hmr: false
    },
    resolve: {
        alias: {
            // these should only be imported by the base-x package in any runtime code
            // and works in the browser with a Uint8Array shim,
            // rather than including a ton of polyfill code
            "safe-buffer": "./scripts/package-overrides/safe-buffer/index.js",
            "buffer": "./scripts/package-overrides/buffer/index.js",
        }
    },
    build: {
        outDir: "../../../target",
        emptyOutDir: true,
        minify: true,
        sourcemap: false,
        assetsInlineLimit: 0,
        polyfillModulePreload: false,
    },
    plugins: [
        // legacyBuild(scriptTagPath(path.join(__dirname, "src/platform/web/index.html"), 0), {
        //     "./Platform": "./LegacyPlatform"
        // }, "hydrogen-legacy", [
        //     './legacy-polyfill',
        // ]),
        // important this comes before service worker
        // otherwise the manifest and the icons it refers to won't be cached
        addLibreJSHeaders(),
        injectWebManifest("assets/manifest.json"),
        injectServiceWorker("sw.js"),
    ],
    define: {
        "HYDROGEN_VERSION": JSON.stringify(version)
    },
    css: {
        postcss: {
            plugins: [
                cssvariables({
                    preserve: (declaration) => {
                        return declaration.value.indexOf("var(--ios-") == 0;
                    }
                }),
                // the grid option creates some source fragment that causes the vite warning reporter to crash because
                // it wants to log a warning on a line that does not exist in the source fragment.
                // autoprefixer({overrideBrowserslist: ["IE 11"], grid: "no-autoplace"}),
                flexbugsFixes()
            ]
        }
    }
};

function scriptTagPath(htmlFile, index) {
    return `${htmlFile}?html-proxy&index=${index}.js`;
}

function addLibreJSHeaders() {
    return addHeaderPlugin((name, fileName) => {
        if (fileName.endsWith(".js")) {
            switch (name) {
                case "index":
                    return {
                        banner: "/* @license magnet:?xt=urn:btih:8e4f440f4c65981c5bf93c76d35135ba5064d8b7&dn=apache-2.0.txt Apache-2.0 */",
                        footer: "/* @license-end */"
                    };
                case "vendor":
                    return {
                        banner: "/* @license multiple but all open source */",
                        footer: "/* @license-end */"
                    }
            }
        }
        return null;
    });
}

function addHeaderPlugin(callback) {
    return {
        name: "hydrogen:addHeader",
        renderChunk: (code, chunk) => {
            const result = callback(chunk.name, chunk.fileName);
            if (result?.banner) {
                code = result.banner + code;
            }
            if (result?.footer) {
                code = code + result.footer;
            }
            return code;
        }
    }
}
