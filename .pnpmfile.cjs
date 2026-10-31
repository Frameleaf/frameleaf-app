module.exports = {
  hooks: {
    readPackage: (pkg) => {
      if (pkg.name !== "exiftool-vendored") {
        return pkg;
      }
      // Production images omit optional dependencies, but still need the platform binary.
      const binaryPackage =
        process.platform === "win32"
          ? "exiftool-vendored.exe"
          : "exiftool-vendored.pl";
      const version = pkg.optionalDependencies?.[binaryPackage];
      if (version) {
        pkg.dependencies ??= {};
        pkg.dependencies[binaryPackage] = version;
        delete pkg.optionalDependencies[binaryPackage];
      }
      return pkg;
    },
  },
};
