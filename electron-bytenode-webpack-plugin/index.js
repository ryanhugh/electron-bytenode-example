const Module = require('module');
const path = require('path');
const v8 = require('v8');

const electronBytenode = require('electron-bytenode');

const ExternalsPlugin = require('webpack/lib/ExternalsPlugin');
const WebpackVirtualModules = require('webpack-virtual-modules');

v8.setFlagsFromString('--no-lazy');

// TODO: deal with entry point loaders (probably just detect and leave them untouched)
// TODO: deal with the absolute/relative import path on the renderer process
// TODO: document things
// TODO: validate against electron-forge's renderer webpack config (depends on multiple entry points support)
// TODO: webpack v5 support

class ElectronBytenodeWebpackPlugin {

  constructor(options = {}) {
    this.name = 'ElectronBytenodeWebpackPlugin';
    this.options = {
      compileAsModule: true,
      debugLifecycle: false,
      debugLogs: false,
      keepSource: false,
      preventSourceMaps: true,
      ...options,
    };
  }

  apply(compiler) {
    this.setupLifecycleLogging(compiler);

    this.debug('original options', {
      context: compiler.options.context,
      devtool: compiler.options.devtool,
      entry: compiler.options.entry,
      output: compiler.options.output,
    });

    const { entry, entryLoaders, externals, output, virtualModules } = this.processOptions(compiler.options);

    this.debug('processed options', {
      entry,
      entryLoaders,
      output,
      virtualModules,
    });

    compiler.options.entry = entry;
    compiler.options.output.filename = output.filename;

    if (this.options.preventSourceMaps) {
      this.log('Preventing source maps from being generated by changing "devtool" to false.');
      compiler.options.devtool = false;
    }

    new ExternalsPlugin("commonjs", externals)
      .apply(compiler);

    new WebpackVirtualModules(virtualModules)
      .apply(compiler);

    this.debug('modified options', {
      devtool: compiler.options.devtool,
      entry: compiler.options.entry,
      output: compiler.options.output,
    });

    compiler.hooks.emit.tapAsync(this.name, async (compilation, callback) => {
      const entryLoaderFiles = [];

      for (const entryLoader of entryLoaders) {
        const entryPoint = compilation.entrypoints.get(entryLoader);
        const files = entryPoint?.getFiles() ?? [];

        entryLoaderFiles.push(...files);
      }

      const outputExtensionRegex = new RegExp('\\' + output.extension + '$', 'i');
      const shouldCompile = name => {
        return outputExtensionRegex.test(name) && !entryLoaderFiles.includes(name);
      };

      for (const { name, source: asset } of compilation.getAssets()) {
        this.debug('emitting', name);

        if (!shouldCompile(name)) {
          continue;
        }

        let source = asset.source();

        if (this.options.compileAsModule) {
          source = Module.wrap(source);
        }

        const compiledAssetName = name.replace(outputExtensionRegex, '.jsc');
        this.debug('compiling to', compiledAssetName);

        const compiledAssetSource = await electronBytenode.compileCode(source);

        compilation.assets[compiledAssetName] = {
          size: () => compiledAssetSource.length,
          source: () => compiledAssetSource,
        }

        if (!this.options.keepSource) {
          delete compilation.assets[name];
        }
      }

      callback();
    })
  }

  processOptions(options) {
    const output = this.preprocessOutput(options);

    const entries = [];
    const entryLoaders = [];
    const externals = [];
    const virtualModules = [];

    for (const { entry, compiled, loader } of this.preprocessEntry(options)) {
      const entryName = output.name ?? entry.name;

      entries.push([entryName, loader.location]);
      entryLoaders.push(entryName);

      const { name } = compiled;

      const from = output.of(entryName);
      const to = output.of(name);

      const relativeImportPath = options.target === 'electron-renderer'
        ? path.join(options.output.path, name)
        : this.toRelativeImportPath(options.output.path, from, to);

      entries.push([name, entry.location]);
      externals.push(relativeImportPath);
      virtualModules.push([loader.location, createLoaderCode(relativeImportPath)]);
    }

    return {
      entry: Object.fromEntries(entries),
      entryLoaders,
      externals,
      output,
      virtualModules: Object.fromEntries(virtualModules),
    };
  }

  toRelativeImportPath(directory, from, to) {
    from = this.removeExtension(from);
    to = this.removeExtension(to);

    const fromLocation = path.join(directory, from);
    const toLocation = path.join(directory, to);

    const relativePath = path.relative(path.dirname(fromLocation), toLocation);

    if (relativePath === to) {
      return `./${relativePath}`;
    }

    return relativePath;
  }

  removeExtension(location) {
    return location.substr(0, location.length - path.extname(location).length);
  }

  preprocessOutput({ output }) {
    let filename = output.filename;

    const { directory, extension, name } = prepare(filename);
    const dynamic = /.*[\[\]]+.*/.test(filename);

    filename = dynamic ? filename : '[name]' + extension;

    return {
      directory,
      dynamic,
      extension,
      filename,
      name: dynamic ? undefined : name,
      of: name => filename.replace('[name]', name),
    };
  }

  preprocessEntry({ context, entry: entries }) {
    if (typeof entries === 'string') {
      entries = [[null, entries]];
    } else if (Array.isArray(entries)) {
      entries = entries.map(entry => [null, entry]);
    } else {
      entries = Object.entries(entries);
    }

    return entries.map(([name, location]) => {
      if (!path.isAbsolute(location)) {
        location = path.resolve(context, location);
      }

      const entry = prepare(location, name);
      const compiled = prepare(location, name, '.compiled');
      const loader = prepare(location, name, '.loader');

      return {
        entry, compiled, loader,
      };
    });
  }

  debug(title, data, ...rest) {
    if (this.options.debugLogs !== true) {
      return;
    }

    if (typeof data === 'object') {
      console.debug('');

      if (typeof title === 'string') {
        title = title.endsWith(':') ? title : `${title}:`;
      }
    }

    this.log(title, data, ...rest);
  }

  log(...messages) {
    console.debug(`[${this.name}]:`, ...messages);
  }

  setupLifecycleLogging(compiler) {
    if (this.options.debugLifecycle !== true) {
      return;
    }

    this.setupHooksLogging('compiler', compiler.hooks);

    compiler.hooks.normalModuleFactory.tap(this.name, normalModuleFactory => {
      this.setupHooksLogging('normalModuleFactory', normalModuleFactory.hooks);

      // this.log({ normalModuleFactory });

      // normalModuleFactory.hooks.module.tap(this.name, (createdModule, result) => {
      //   this.log(createdModule.constructor.name, { createdModule, result });
      // });

      // normalModuleFactory.hooks.afterResolve.tap(this.name, data => {
      //   this.log({ data, loaders: data.loaders });
      // });
    });

    compiler.hooks.compilation.tap(this.name, compilation => {
      this.setupHooksLogging('compilation', compilation.hooks);

      compilation.hooks.addEntry.tap(this.name, (context, entry) => {
        this.log({ context, entry });
      });

      // compilation.hooks.chunkAsset.tap(this.name, (chunk, filename) => {
      //   this.log({ chunk, filename });
      // });

      // compilation.hooks.afterChunks.tap(this.name, chunks => {
      //   this.log({ chunks });
      // });

      // compilation.hooks.buildModule.tap(this.name, module => {
      //   this.log(module.constructor.name, { module });
      // });
    });
  }

  setupHooksLogging(type, hooks) {
    const name = this.name;

    for (const [hookName, hook] of Object.entries(hooks)) {
      try {
        hook.tap(name, function () {
          console.debug(`[${name}]: ${type} hook: ${hookName} (${arguments.length} arguments)`);
        });
      } catch (e) {}
    }
  }
}

function createLoaderCode(relativePath) {
  return `
    require('bytenode');
    require('${relativePath}');
  `;
}

function prepare(location, name, suffix = '') {
  const directory = path.dirname(location);
  const extension = path.extname(location);
  const basename = path.basename(location, extension) + suffix;
  const filename = basename + extension;

  name = name ? name + suffix : basename;
  location = path.join(directory, filename);

  return {
    basename, directory, extension, filename, location, name, suffix,
  };
}

module.exports = ElectronBytenodeWebpackPlugin;
