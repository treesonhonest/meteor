var main = require('./main.js');
var path = require('path');
var _ = require('underscore');
var fs = require("fs");
var files = require('./files.js');
var deploy = require('./deploy.js');
var library = require('./library.js');
var buildmessage = require('./buildmessage.js');
var unipackage = require('./unipackage.js');
var project = require('./project.js');
var warehouse = require('./warehouse.js');
var auth = require('./auth.js');
var config = require('./config.js');
var release = require('./release.js');
var Future = require('fibers/future');

// Given a site name passed on the command line (eg, 'mysite'), return
// a fully-qualified hostname ('mysite.meteor.com').
//
// This is fairly simple for now. It appends 'meteor.com' if the name
// doesn't contain a dot, and it deletes any trailing dots (the
// technically legal hostname 'mysite.com.' is canonicalized to
// 'mysite.com').
//
// In the future, you should be able to make this default to some
// other domain you control, rather than 'meteor.com'.
var qualifySitename = function (site) {
  if (site.indexOf(".") === -1)
    site = site + ".meteor.com";
  while (site.length && site[site.length - 1] === ".")
    site = site.substring(0, site.length - 1);
  return site;
};

// Given a (non necessarily fully qualified) site name from the
// command line, return true if the site is hosted by a Galaxy, else
// false.
var hostedWithGalaxy = function (site) {
  var site = qualifySitename(site);
  return !! require('./deploy-galaxy.js').discoverGalaxy(site);
};

///////////////////////////////////////////////////////////////////////////////
// options that act like commands
///////////////////////////////////////////////////////////////////////////////

// Prints the Meteor architecture name of this host
main.registerCommand({
  name: '--arch',
  requiresRelease: false
}, function (options) {
  var archinfo = require('./archinfo.js');
  console.log(archinfo.host());
});

// Prints the current release in use. Note that if there is not
// actually a specific release, we print to stderr and exit non-zero,
// while if there is a release we print to stdout and exit zero
// (making this useful to scripts).
main.registerCommand({
  name: '--version',
  requiresRelease: false
}, function (options) {
  if (release.current === null) {
    if (! options.appDir)
      throw new Error("missing release, but not in an app?");
    process.stderr.write(
"This project was created with a checkout of Meteor, rather than an\n" +
"official release, and doesn't have a release number associated with\n" +
"it. You can set its release with 'meteor update'.\n");
    return 1;
  }

  if (release.current.isCheckout()) {
    process.stderr.write("Unreleased (running from a checkout)\n");
    return 1;
  }

  console.log("Release " + release.current.name);
});

// Internal use only.
main.registerCommand({
  name: '--built-by',
  requiresRelease: false
}, function (options) {
  var packages = require('./packages.js');
  console.log(packages.BUILT_BY);
});

// Internal use only. Makes sure that your Meteor install is totally
// good to go (is "airplane safe" and won't do any lengthy building on
// first run).
//
// In a checkout, this makes sure that the checkout is "complete" (dev
// bundle downloaded and all NPM modules installed). Otherwise, this
// runs one full update cycle, to make sure that you have the latest
// manifest and all of the packages in it.
main.registerCommand({
  name: '--get-ready',
  requiresRelease: false
}, function (options) {
  if (files.usesWarehouse()) {
    var updater = require('./updater.js');
    updater.tryToDownloadUpdate(true /* silent */);
  } else {
    // dev bundle is downloaded by the wrapper script. We just need
    // to install NPM dependencies.
    if (! release.current)
      // This is a weird case. Fail silently.
      return 0;
    _.each(release.current.library.list(), function (p) {
      p.preheat();
    });
  }
});

///////////////////////////////////////////////////////////////////////////////
// run
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'run',
  requiresApp: true,
  options: {
    port: { type: Number, short: "p", default: 3000 },
    production: { type: Boolean },
    'raw-logs': { type: Boolean },
    settings: { type: String },
    program: { type: String },
    // With --once, meteor does not re-run the project if it crashes
    // and does not monitor for file changes. Intentionally
    // undocumented: intended for automated testing (eg, cli-test.sh),
    // not end-user use. #Once
    once: { type: Boolean }
  }
}, function (options) {
  if (release.forced) {
    var appRelease = project.getMeteorReleaseVersion(options.appDir);
    if (release.current.name !== appRelease) {
      console.log("=> Using Meteor %s as requested (overriding Meteor %s)",
                  release.current.name, appRelease);
      console.log();
    }
  }

  auth.tryRevokeOldTokens({timeout: 1000});

  var runner = require('./runner.js');
  return runner.run(options.appDir, {
    port: options.port,
    rawLogs: options['raw-logs'],
    settingsFile: options.settings,
    program: options.program || undefined,
    buildOptions: {
      minify: options.minify
    },
    once: options.once
  });
});

///////////////////////////////////////////////////////////////////////////////
// create
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'create',
  maxArgs: 1,
  options: {
    list: { type: Boolean },
    example: { type: String }
  }
}, function (options) {
  // Suppose you have an app A, and from some directory inside that
  // app, you run 'meteor create /my/new/app'. The new app should use
  // the latest available Meteor release, not the release that A
  // uses. So if we were run from inside an app directory, and the
  // user didn't force a release with --release, we need to
  // springboard to the correct release and tools version.
  //
  // (In particular, it's not sufficient to create the new app with
  // this version of the tools, and then stamp on the correct release
  // at the end.)
  if (! release.current.isCheckout()) {
    var desiredRelease = release.forced ? release.current.name :
      release.latestDownloaded();
    if (release.current.name !== desiredRelease)
      throw new main.SpringboardToRelease(desiredRelease); // does not return
  }

  var appPath;
  if (options.args.length === 1)
    appPath = options.args[0];
  else if (options.example)
    appPath = options.example;
  else
    throw new main.ShowUsage;

  var exampleDir = path.join(__dirname, '..', 'examples');
  var examples = _.reject(fs.readdirSync(exampleDir), function (e) {
    return (e === 'unfinished' || e === 'other'  || e[0] === '.');
  });

  if (options.list) {
    process.stdout.write("Available examples:\n");
    _.each(examples, function (e) {
      process.stdout.write("  " + e + "\n");
    });
    process.stdout.write("\n" +
"Create a project from an example with 'meteor create --example <name>'.\n");
    return 1;
  };

  if (fs.existsSync(appPath)) {
    process.stderr.write(appPath + ": Already exists\n");
    return 1;
  }

  if (files.findAppDir(appPath)) {
    process.stderr.write(
      "You can't create a Meteor project inside another Meteor project.\n");
    return 1;
  }

  var transform = function (x) {
    return x.replace(/~name~/g, path.basename(appPath));
  };

  if (options.example) {
    if (examples.indexOf(options.example) === -1) {
      process.stderr.write(options.example + ": no such example\n\n");
      process.stderr.write("List available applications with 'meteor create --list'.\n");
      return 1;
    } else {
      files.cp_r(path.join(exampleDir, options.example), appPath, {
        ignore: [/^local$/]
      });
    }
  } else {
    files.cp_r(path.join(__dirname, 'skel'), appPath, {
      transformFilename: function (f) {
        return transform(f);
      },
      transformContents: function (contents, f) {
        if ((/(\.html|\.js|\.css)/).test(f))
          return new Buffer(transform(contents.toString()));
        else
          return contents;
      },
      ignore: [/^local$/]
    });
  }

  project.writeMeteorReleaseVersion(
    appPath, release.current.isCheckout() ? "none" : release.current.name);

  process.stderr.write(appPath + ": created");
  if (options.example && options.example !== appPath)
    process.stderr.write(" (from '" + options.example + "' template)");
  process.stderr.write(".\n\n");

  process.stderr.write(
    "To run your new app:\n" +
      "   cd " + appPath + "\n" +
      "   meteor\n");
});

///////////////////////////////////////////////////////////////////////////////
// update
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'update',
  options: {
    // Undocumented flag (used, eg, by upgrade-to-engine.js).
    'dont-fetch-latest': { type: Boolean }
  },
  // We have to be able to work without a release, since 'meteor
  // update' is how you fix apps that don't have a release.
  requiresRelease: false
}, function (options) {
  // refuse to update if we're in a git checkout.
  if (! files.usesWarehouse()) {
    process.stderr.write(
      "update: can only be run from official releases, not from checkouts\n");
    return 1;
  }

  var couldNotContactServer = false;

  // Unless --release was passed (meaning that either the user asked
  // for a particular release, or that we _just did_ this and
  // springboarded), go get the latest release and switch to it.
  if (! release.forced) {
    if (! options["dont-fetch-latest"]) {
      try {
        warehouse.fetchLatestRelease();
      } catch (e) {
        if (! (e instanceof files.OfflineError)) {
          console.error("Failed to update Meteor.");
          throw e;
        }
        // If the problem appears to be that we're offline, just log and
        // continue.
        console.log("Can't contact the update server. Are you online?");
        couldNotContactServer = true;
      }
    }

    if (! release.current ||
        release.current.name !== release.latestDownloaded()) {
      // The user asked for the latest release (well, they "asked for
      // it" by not passing --release). We just downloaded a new
      // release, so springboard to it. (Or, we were run in app with
      // no release, so springboard to the lastest release we know
      // about, whether we just download it or not.)
      // #UpdateSpringboard
      //
      // (We used to springboard only if the tools version actually
      // changed between the old and new releases. Now we do it
      // unconditionally, because it's not a big deal to do it and it
      // eliminates the complexity of the current release changing.)
      throw new main.SpringboardToRelease(release.latestDownloaded());
    }
  }

  // At this point we should have a release. (If we didn't to start
  // with, #UpdateSpringboard fixed that.) And it can't be a checkout,
  // because we checked for that at the very beginning.
  if (! release.current || ! release.current.isProperRelease())
    throw new Error("don't have a proper release?");

  // If we're not in an app, then we're done (other than maybe printing some
  // stuff).
  if (! options.appDir) {
    if (options["dont-fetch-latest"])
      return;
    if (release.forced) {
      // We get here if:
      // 1) the user ran 'meteor update' and we found a new version
      // 2) the user ran 'meteor update --release xyz' (regardless of
      //    whether we found a new release)
      //
      // In case (1), we downloaded and installed the update and then
      // we springboarded (at #UpdateSpringboard above), causing
      // release.forced to be true.
      //
      // In case (2), we downloaded, installed, and springboarded to
      // the requested release in the initialization code, before the
      // command even ran. They could equivalently have run 'meteor
      // help --release xyz'.
      console.log(
"Installed. Run 'meteor update' inside of a particular project\n" +
"directory to update that project to Meteor %s.", release.current.name);
    } else {
      // We get here if the user ran 'meteor update' and we didn't
      // find a new version.

      if (couldNotContactServer) {
        // We already printed an error message about our inability to
        // ask the server if we're up to date.
      } else {
        console.log(
"The latest version of Meteor, %s, is already installed on this\n" +
"computer. Run 'meteor update' inside of a particular project\n" +
"directory to update that project to Meteor %s.",
          release.current.name, release.current.name);
      }
    }
    return;
  }

  // Otherwise, we have to upgrade the app too, if the release changed.
  var appRelease = project.getMeteorReleaseVersion(options.appDir);
  if (appRelease !== null && appRelease === release.current.name) {
    if (couldNotContactServer) {
      console.log(
"This project is already at Meteor %s, the latest release\n" +
"installed on this computer.", appRelease);
    } else {
      console.log(
"This project is already at Meteor %s, the latest release.", appRelease);
    }
    return;
  }

  // Write the release to .meteor/release.
  project.writeMeteorReleaseVersion(options.appDir, release.current.name);

  // Find upgraders (in order) necessary to upgrade the app for the new
  // release (new metadata file formats, etc, or maybe even updating renamed
  // APIs).
  //
  // * If this is a pre-engine app with no .meteor/release file, run
  //   all upgraders.
  // * If the app didn't have a release because it was created by a
  //   checkout, don't run any upgraders.
  if (appRelease !== "none") {
    // NB! This call to release.load() may have to fetch the release
    // from the server. If so, it will print progress messages and
    // even kill the program if it doesn't get what it wants!
    var oldUpgraders =
      appRelease === null ? [] : release.load(appRelease).getUpgraders();
    var upgraders = _.difference(release.current.getUpgraders(),
                                 oldUpgraders);
    _.each(upgraders, function (upgrader) {
      require("./upgraders.js").runUpgrader(upgrader, options.appDir);
    });
  }

  // This is the right spot to do any other changes we need to the app in
  // order to update it for the new release.
  console.log("%s: updated to Meteor %s.",
              path.basename(options.appDir), release.current.name);

  // Print any notices relevant to this upgrade.
  // XXX This doesn't include package-specific notices for packages that
  // are included transitively (eg, packages used by app packages).
  var packages = project.getPackages(options.appDir);
  warehouse.printNotices(appRelease, release.current.name, packages);
});

///////////////////////////////////////////////////////////////////////////////
// run-upgrader
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'run-upgrader',
  hidden: true,
  minArgs: 1,
  maxArgs: 1,
  requiresApp: true
}, function (options) {
  var upgrader = options.args[0];

  var upgraders = require("./upgraders.js");
  console.log("%s: running upgrader %s.",
              path.basename(options.appDir), upgrader);
  upgraders.runUpgrader(upgrader, options.appDir);
});

///////////////////////////////////////////////////////////////////////////////
// add
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'add',
  minArgs: 1,
  maxArgs: Infinity,
  requiresApp: true
}, function (options) {
  var all = release.current.library.list();
  var using = {};
  _.each(project.getPackages(options.appDir), function (name) {
    using[name] = true;
  });

  _.each(options.args, function (name) {
    if (! (name in all)) {
      process.stderr.write(name + ": no such package\n");
    } else if (name in using) {
      process.stderr.write(name + ": already using\n");
    } else {
      project.addPackage(options.appDir, name);
      var note = all[name].metadata.summary || '';
      process.stderr.write(name + ": " + note + "\n");
    }
  });
});

///////////////////////////////////////////////////////////////////////////////
// remove
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'remove',
  minArgs: 1,
  maxArgs: Infinity,
  requiresApp: true
}, function (options) {
  var using = {};
  _.each(project.getPackages(options.appDir), function (name) {
    using[name] = true;
  });

  _.each(options.args, function (name) {
    if (! (name in using)) {
      process.stderr.write(name + ": not in project\n");
    } else {
      project.removePackage(options.appDir, name);
      process.stderr.write(name + ": removed\n");
    }
  });
});

///////////////////////////////////////////////////////////////////////////////
// list
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'list',
  requiresApp: true,
  options: {
    using: { type: Boolean }
  }
}, function (options) {
  if (options.using) {
    var using = project.getPackages(options.appDir);

    if (using.length) {
      _.each(using, function (name) {
        process.stdout.write(name + "\n");
      });
    } else {
      process.stderr.write(
"This project doesn't use any packages yet. To add some packages:\n" +
"  meteor add <package> <package> ...\n" +
"\n" +
"To see available packages:\n" +
"  meteor list\n");
    }
    return;
  }

  var list = release.current.library.list();
  var names = _.keys(list);
  names.sort();
  var pkgs = [];
  _.each(names, function (name) {
    pkgs.push(list[name]);
  });
  process.stdout.write("\n" + library.formatList(pkgs) + "\n");
});


///////////////////////////////////////////////////////////////////////////////
// bundle
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'bundle',
  minArgs: 1,
  maxArgs: 1,
  requiresApp: true,
  options: {
    debug: { type: Boolean },
    // Undocumented
    'for-deploy': { type: Boolean }
  }
}, function (options) {
  // XXX if they pass a file that doesn't end in .tar.gz or .tgz, add
  // the former for them

  // XXX output, to stderr, the name of the file written to (for human
  // comfort, especially since we might change the name)

  // XXX name the root directory in the bundle based on the basename
  // of the file, not a constant 'bundle' (a bit obnoxious for
  // machines, but worth it for humans)

  var buildDir = path.join(options.appDir, '.meteor', 'local', 'build_tar');
  var bundlePath = path.join(buildDir, 'bundle');
  var outputPath = path.resolve(options.args[0]); // get absolute path

  var bundler = require(path.join(__dirname, 'bundler.js'));
  var bundleResult = bundler.bundle({
    appDir: options.appDir,
    outputPath: bundlePath,
    nodeModulesMode: options['for-deploy'] ? 'skip' : 'copy',
    buildOptions: {
      minify: ! options.debug
    }
  });
  if (bundleResult.errors) {
    process.stdout.write("Errors prevented bundling:\n");
    process.stdout.write(bundleResult.errors.formatMessages());
    return 1;
  }

  try {
    files.createTarball(path.join(buildDir, 'bundle'), outputPath);
  } catch (err) {
    console.log(JSON.stringify(err));
    process.stderr.write("Couldn't create tarball\n");
  }
  files.rm_recursive(buildDir);
});

///////////////////////////////////////////////////////////////////////////////
// mongo
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'mongo',
  maxArgs: 1,
  options: {
    url: { type: Boolean, short: 'U' }
  },
  requiresApp: function (options) {
    return options.args.length === 0;
  }
}, function (options) {
  var mongoUrl;

  if (options.args.length === 0) {
    // localhost mode
    var findMongoPort =
      require(path.join(__dirname, 'run-mongo.js')).findMongoPort;
    var mongoPort = mongoRunner.findMongoPort(options.appDir);
    if (! mongoPort) {
      process.stdout.write(
"mongo: Meteor isn't running.\n" +
"\n" +
"This command only works while Meteor is running your application\n" +
"locally. Start your application first.\n");
      return 1;
    }
    mongoUrl = "mongodb://127.0.0.1:" + mongoPort + "/meteor";

  } else {
    // remote mode
    var site = qualifySitename(options.args[0]);
    config.printUniverseBanner();

    if (hostedWithGalaxy(site)) {
      var deployGalaxy = require('./deploy-galaxy.js');
      mongoUrl = deployGalaxy.temporaryMongoUrl(site);
    } else {
      mongoUrl = deploy.temporaryMongoUrl(site);
    }
  }
  if (options.url) {
    console.log(mongoUrl);
  } else {
    process.stdin.pause();
    deploy.runMongoShell(mongoUrl);
    throw new main.WaitForExit;
  }
});

///////////////////////////////////////////////////////////////////////////////
// reset
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'reset',
  // Doesn't actually take an argument, but we want to print an custom
  // error message if they try to pass one.
  maxArgs: 1,
  requiresApp: true
}, function (options) {
  if (options.args.length !== 0) {
    process.stderr.write(
"meteor reset only affects the locally stored database.\n" +
"\n" +
"To reset a deployed application use\n" +
"  meteor deploy --delete appname\n" +
"followed by\n" +
"  meteor deploy appname\n");
    return 1;
  }

  var findMongoPort =
    require(path.join(__dirname, 'run-mongo.js')).findMongoPort;
  var isRunning = !! mongoRunner.findMongoPort(options.appDir);
  if (isRunning) {
    process.stderr.write(
"reset: Meteor is running.\n" +
"\n" +
"This command does not work while Meteor is running your application.\n" +
"Exit the running Meteor development server.\n");
    return 1;
  }

  var localDir = path.join(options.appDir, '.meteor', 'local');
  files.rm_recursive(localDir);

  process.stdout.write("Project reset.\n");
});

///////////////////////////////////////////////////////////////////////////////
// deploy
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'deploy',
  minArgs: 0,
  maxArgs: 1,
  options: {
    'delete': { type: Boolean, short: 'D' },
    debug: { type: Boolean },
    settings: { type: String },
    star: { type: String },
    // No longer supported, but we still parse it out so that we can
    // print a custom error message.
    password: { type: String },
    // Shouldn't be documented until the Galaxy release. Marks the
    // application as an admin app, so that it will be available in
    // Galaxy admin interface.
    admin: { type: Boolean }
  },
  requiresApp: function (options) {
    return options.delete || options.star ? false : true;
  }
}, function (options) {
  var site = qualifySitename(options.args[0]);
  config.printUniverseBanner();
  var useGalaxy = hostedWithGalaxy(site);

  if (options.delete) {
    if (useGalaxy) {
      var deployGalaxy = require('./deploy-galaxy.js');
      deployGalaxy.deleteApp(site);
    } else {
      deploy.deleteApp(site);
    }
    return;
  }

  if (options.password) {
    if (useGalaxy) {
      process.stderr.write("Galaxy does not support --password.\n");
    } else {
      process.stderr.write(
"Setting passwords on apps is no longer supported. Now there are\n" +
"user accounts and your apps are associated with your account so that\n" +
"only you (and people you designate) can access them. See the\n" +
"'meteor claim' and 'meteor authorized' commands.\n");
    }
    return 1;
  }

  var starball = options.star;
  if (starball && ! useGalaxy) {
    // XXX it would be nice to support this for non-Galaxy deploys too
    process.stderr.write(
"--star: only supported when deploying to Galaxy.\n");
    return 1;
  }

  var settings = undefined;
  if (options.settings)
    settings = files.getSettings(options.settings);

  if (! auth.isLoggedIn()) {
    process.stderr.write(
"To instantly deploy your app on a free testing server, just enter your\n" +
"email address!\n" +
"\n");

    if (! auth.registerOrLogIn())
      return 1;
  }

  var buildOptions = {
    minify: ! options.debug
  };

  if (useGalaxy) {
    var deployGalaxy = require('./deploy-galaxy.js');
    deployGalaxy.deploy({
      app: site,
      appDir: options.appDir,
      settings: settings,
      starball: starball,
      buildOptions: buildOptions,
      admin: options.admin
    });
  } else {
    deploy.bundleAndDeploy({
      appDir: options.appDir,
      site: site,
      settings: settings,
      buildOptions: buildOptions
    });
  }
});

///////////////////////////////////////////////////////////////////////////////
// logs
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'logs',
  minArgs: 1,
  maxArgs: 1,
  options: {
    // XXX once Galaxy is released, document this
    stream: { type: Boolean, short: 'f' }
  }
}, function (options) {
  var site = qualifySitename(options.args[0]);

  if (hostedWithGalaxy(site)) {
    var deployGalaxy = require('./deploy-galaxy.js');
    deployGalaxy.logs({
      app: site,
      streaming: options.stream
    });
    if (options.stream)
      throw new main.WaitForExit;
  } else {
    deploy.logs(site);
  }
});

///////////////////////////////////////////////////////////////////////////////
// authorized
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'authorized',
  minArgs: 1,
  maxArgs: 1,
  options: {
    add: { type: String, short: 'a' },
    remove: { type: String, short: 'r' },
    list: { type: Boolean }
  }
}, function (options) {

  if (options.add && options.remove) {
    process.stderr.write(
      "Sorry, you can only add or remove one user at a time.\n");
    return 1;
  }

  if ((options.add || options.remove) && options.list) {
    process.stderr.write(
"Sorry, you can't change the users at the same time as you're listing them.\n");
    return 1;
  }

  config.printUniverseBanner();
  var site = qualifySitename(options.args[0]);

  if (hostedWithGalaxy(site)) {
    process.stderr.write(
"Sites hosted on Galaxy do not have an authorized user list.\n" +
"Instead, go to your Galaxy dashboard to change the authorized users\n" +
"of your Galaxy.\n");
    return 1;
  }

  if (! auth.isLoggedIn()) {
    process.stderr.write(
      "You must be logged in for that. Try 'meteor login'.\n");
    return 1;
  }

  if (options.add)
    deploy.changeAuthorized(site, "add", options.add);
  else if (options.remove)
    deploy.changeAuthorized(site, "remove", options.remove);
  else
    deploy.listAuthorized(site);
});

///////////////////////////////////////////////////////////////////////////////
// claim
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'claim',
  minArgs: 1,
  maxArgs: 1
}, function (options) {
  config.printUniverseBanner();
  var site = qualifySitename(options.args[0]);

  if (! auth.isLoggedIn()) {
    process.stderr.write(
      "You must be logged in to claim sites. Try 'meteor login'.\n");
    return 1;
  }

  if (hostedWithGalaxy(site)) {
    process.stderr.write(
      "Sorry, you can't claim sites that are hosted on Galaxy.\n");
    return 1;
  }

  deploy.claim(site);
});


///////////////////////////////////////////////////////////////////////////////
// test-packages
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'test-packages',
  maxArgs: Infinity,
  options: {
    port: { type: Number, short: "p", default: 3000 },
    deploy: { type: String },
    production: { type: Boolean },
    settings: { type: String },
    // Undocumented. See #Once
    once: { type: Boolean },
    // Undocumented. To ensure that QA covers both
    // PollingObserveDriver and OplogObserveDriver, this option
    // disables oplog for tests.  (It still creates a replset, it just
    // doesn't do oplog tailing.)
    'disable-oplog': { type: Boolean },
    // Undocumented flag to use a different test driver.
    'driver-package': { type: String }
  }
}, function (options) {
  var library = release.current.library;

  var testPackages;
  if (options.args.length === 0) {
    // XXX The call to list() here is unfortunate, because list()
    // can fail (eg, a package has a parse error) and if it does
    // we currently just exit! Which sucks because we don't get
    // reloading.
    testPackages = _.keys(library.list());
  } else {
    testPackages = _.map(options.args, function (p) {
      // If it's a package name, just pass it through.
      if (p.indexOf('/') === -1)
        return p;

      // Otherwise it's a directory; load it into a Package now. Use
      // path.resolve to strip trailing slashes, so that packageName doesn't
      // have a trailing slash.
      var packageDir = path.resolve(p);
      var packageName = path.basename(packageDir);
      library.override(packageName, packageDir);
      return packageName;
    });
  }

  // Make a temporary app dir (based on the test runner app). This will be
  // cleaned up on process exit. Using a temporary app dir means that we can
  // run multiple "test-packages" commands in parallel without them stomping
  // on each other.
  //
  // Note: testRunnerAppDir deliberately DOES NOT MATCH the app
  // package search path baked into release.current.library: we are
  // bundling the test runner app, but finding app packages from the
  // current app (if any).
  var testRunnerAppDir = files.mkdtemp('meteor-test-run');
  files.cp_r(path.join(__dirname, 'test-runner-app'), testRunnerAppDir);
  project.writeMeteorReleaseVersion(testRunnerAppDir,
                                    release.current.name || 'none');
  project.addPackage(testRunnerAppDir,
                     options['driver-package'] || 'test-in-browser');

  var buildOptions = {
    testPackages: testPackages,
    minify: options.production
  };

  if (options.deploy) {
    deploy.bundleAndDeploy({
      appDir: testRunnerAppDir,
      site: options.deploy,
      settings: options.settings && files.getSettings(options.settings),
      buildOptions: buildOptions
    });
  } else {
    var runner = require('./runner.js');
    return runner.run(testRunnerAppDir, {
      // if we're testing packages from an app, we still want to make
      // sure the user doesn't 'meteor update' in the app, requiring
      // a switch to a different release
      appDirForVersionCheck: options.appDir,
      port: options.port,
      disableOplog: options['disable-oplog'],
      settingsFile: options.settings,
      banner: "Tests",
      buildOptions: buildOptions,
      once: options.once
    });
  }
});

///////////////////////////////////////////////////////////////////////////////
// rebuild-all
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'rebuild-all',
  hidden: true
}, function (options) {
  if (options.appDir) {
    // The library doesn't know about other programs in your app. Let's blow
    // away their .build directories if they have them, and not rebuild
    // them. Sort of hacky, but eh.
    var programsDir = path.join(options.appDir, 'programs');
    try {
      var programs = fs.readdirSync(programsDir);
    } catch (e) {
      // OK if the programs directory doesn't exist; that'll just leave
      // 'programs' empty.
      if (e.code !== "ENOENT")
        throw e;
    }
    _.each(programs, function (program) {
      files.rm_recursive(path.join(programsDir, program, '.build'));
    });
  }

  var count = null;
  var messages = buildmessage.capture(function () {
    count = release.current.library.rebuildAll();
  });
  if (count)
    console.log("Built " + count + " packages.");
  if (messages.hasMessages()) {
    process.stdout.write("\n" + messages.formatMessages());
    return 1;
  }
});


///////////////////////////////////////////////////////////////////////////////
// run-command
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'run-command',
  hidden: true,
  raw: true
}, function (options) {
  // This is marked as raw, so we have to do all of our argument
  // parsing ourselves. This lets us make sure that the arguments to
  // the command being run don't get accidentally intrepreted.

  var library = release.current.library;
  var argv = process.argv.slice(3);
  if (! argv.length || argv[0] === "--help")
    throw new main.ShowUsage;

  if (! fs.existsSync(argv[0]) ||
      ! fs.statSync(argv[0]).isDirectory()) {
    process.stderr.write(argv[0] + ": not a directory\n");
    return 1;
  }

  // Build and load the package
  var world, packageName;
  var messages = buildmessage.capture(
    { title: "building the program" }, function () {
      // Make the directory visible as a package. Derive the last
      // package name from the last component of the directory, and
      // bail out if that creates a conflict.
      var packageDir = path.resolve(argv[0]);
      packageName = path.basename(packageDir) + "-tool";
      if (library.get(packageName, false)) {
        buildmessage.error("'" + packageName +
                           "' conflicts with the name " +
                           "of a package in the library");
      }
      library.override(packageName, packageDir);

      world = unipackage.load({
        library: library,
        packages: [ packageName ],
        release: release.current.name
      });
    });
  if (messages.hasMessages()) {
    process.stderr.write(messages.formatMessages());
    return 1;
  }

  if (! ('main' in world[packageName])) {
    process.stderr.write("Package does not define a main() function.\n");
    return 1;
  }

  var ret = world[packageName].main(argv.slice(1));
  // let exceptions propagate and get printed by node
  if (ret === undefined)
    ret = 0;
  if (typeof ret !== "number")
    ret = 1;
  ret = +ret; // cast to integer
  return ret;
});

///////////////////////////////////////////////////////////////////////////////
// login
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'login',
  options: {
    email: { type: String },
    galaxy: { type: String }
  }
}, function (options) {
  return auth.loginCommand(options);
});


///////////////////////////////////////////////////////////////////////////////
// logout
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'logout'
}, function (options) {
  return auth.logoutCommand(options);
});


///////////////////////////////////////////////////////////////////////////////
// whoami
///////////////////////////////////////////////////////////////////////////////

main.registerCommand({
  name: 'whoami'
}, function (options) {
  return auth.whoAmICommand(options);
});
