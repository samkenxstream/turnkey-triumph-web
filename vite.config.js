const injectWebManifest = require("./scripts/build-plugins/manifest");
const {injectServiceWorker, createPlaceholderValues} = require("./scripts/build-plugins/service-worker");
const themeBuilder = require("./scripts/build-plugins/rollup-plugin-build-themes");
const {defineConfig} = require('vite');
const mergeOptions = require('merge-options').bind({concatArrays: true});
const {commonOptions, compiledVariables} = require("./vite.common-config.js");

export default defineConfig(({mode}) => {
    const definePlaceholders = createPlaceholderValues(mode);
    return mergeOptions(commonOptions, {
        root: "src/platform/web",
        base: "./",
        build: {
            outDir: "../../../target",
            minify: true,
            sourcemap: true,
        },
        plugins: [
            themeBuilder({
                themeConfig: {
                    themes: {"element": "./src/platform/web/ui/css/themes/element"},
                    default: "element",
                },
                compiledVariables
            }),
            // important this comes before service worker
            // otherwise the manifest and the icons it refers to won't be cached
            injectWebManifest("assets/manifest.json"),
            injectServiceWorker("./src/platform/web/sw.js", ["index.html"], {
                // placeholders to replace at end of build by chunk name
                "index": {DEFINE_GLOBAL_HASH: definePlaceholders.DEFINE_GLOBAL_HASH},
                "sw": definePlaceholders
            }),
        ],
        define: definePlaceholders,
    });
});
