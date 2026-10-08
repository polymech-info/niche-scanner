import path from "path";
import { fileURLToPath } from "url";
import { rspack } from "@rspack/core";
import { ReactRefreshRspackPlugin } from "@rspack/plugin-react-refresh";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Single all-in-one client bundle for npm publish + local `runny`. */
export default (env = {}, argv = {}) => {
  const isDev = argv.mode !== "production";
  const isWeb = env.preset === "web";
  const stem = isWeb ? "niche-scanner" : "runny";

  return {
    target: "web",
    entry: path.resolve(__dirname, "src/client/main.tsx"),
    output: {
      path: path.resolve(
        __dirname,
        isWeb ? "dist/client-web" : "dist/client"
      ),
      publicPath: isWeb ? "/apps/niche-scanner/" : "/",
      filename: `${stem}.bundle.js`,
      chunkFilename: `${stem}.[name].js`,
      assetModuleFilename: `${stem}.[name][ext]`,
      clean: true,
    },
    resolve: {
      extensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
      extensionAlias: {
        ".js": [".ts", ".tsx", ".js"],
      },
      alias: {
        "@": path.resolve(__dirname, "src/client"),
      },
    },
    module: {
      rules: [
        {
          test: /\.[jt]sx?$/,
          include: [
            path.resolve(__dirname, "src/client"),
            path.resolve(__dirname, "src/shared"),
          ],
          loader: "builtin:swc-loader",
          options: {
            jsc: {
              parser: { syntax: "typescript", tsx: true },
              transform: {
                react: {
                  runtime: "automatic",
                  development: isDev,
                  refresh: isDev,
                },
              },
              target: "es2022",
            },
          },
        },
        {
          test: /\.css$/,
          use: ["style-loader", "css-loader", "postcss-loader"],
        },
        {
          test: /\.svg$/i,
          type: "asset/resource",
        },
      ],
    },
    plugins: [
      new rspack.HtmlRspackPlugin({
        template: path.resolve(__dirname, "src/client/index.html"),
        filename: "index.html",
        inject: "body",
        title: isWeb ? "niche-scanner" : "Phrases",
        minify: !isDev,
      }),
      new rspack.CopyRspackPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, "src/client/public/favicon.svg"),
            to: "favicon.svg",
          },
        ],
      }),
      isDev && new ReactRefreshRspackPlugin(),
    ].filter(Boolean),
    devtool: isDev ? "eval-source-map" : false,
    performance: { hints: false },
    // One sync JS file — no async chunk fan-out for the published CLI UI.
    optimization: {
      splitChunks: false,
      runtimeChunk: false,
    },
    devServer: {
      host: "127.0.0.1",
      port: 5175,
      hot: true,
      historyApiFallback: {
        index: "/index.html",
        disableDotRule: true,
      },
      allowedHosts: "all",
      proxy: [
        {
          context: ["/api"],
          target: "http://127.0.0.1:3780"
        },
      ],
      setupMiddlewares: (middlewares) => {
        middlewares.unshift({
          name: "spa-fallback",
          middleware: (req, res, next) => {
            if (req.method !== "GET" && req.method !== "HEAD") return next();
            const pathOnly = String(req.url ?? "").split("?")[0];
            if (
              pathOnly.startsWith("/api") ||
              pathOnly.startsWith("/ws") ||
              /\.[a-zA-Z0-9]+$/.test(pathOnly)
            ) {
              return next();
            }
            req.url = "/index.html";
            next();
          },
        });
        return middlewares;
      },
    },
  };
};
