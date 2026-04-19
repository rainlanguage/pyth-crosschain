{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs";
    flake-utils.url = "github:numtide/flake-utils";
    mkCli.url = "github:cprussin/mkCli";
  };

  outputs = {
    nixpkgs,
    flake-utils,
    mkCli,
    ...
  }: (
    flake-utils.lib.eachDefaultSystem
    (
      system: let
        cli-overlay = _: prev: {
          cli = prev.lib.mkCli "cli" {
            _noAll = true;

            start = "${prev.lib.getExe prev.pnpm} turbo start:dev";

            test = {
              nix = {
                lint = "${prev.statix}/bin/statix check --ignore node_modules .";
                dead-code = "${prev.deadnix}/bin/deadnix --exclude ./node_modules .";
                format = "${prev.alejandra}/bin/alejandra --exclude ./node_modules --check .";
              };
              turbo = "${prev.lib.getExe prev.pnpm} turbo test -- --ui stream";
            };

            fix = {
              nix = {
                lint = "${prev.statix}/bin/statix fix --ignore node_modules .";
                dead-code = "${prev.deadnix}/bin/deadnix --exclude ./node_modules -e .";
                format = "${prev.alejandra}/bin/alejandra --exclude ./node_modules .";
              };
              turbo = "${prev.lib.getExe prev.pnpm} turbo fix -- --ui stream";
            };
          };
        };

        pkgs = import nixpkgs {
          inherit system;
          overlays = [mkCli.overlays.default cli-overlay];
          config = {};
        };
      in {
        devShells.default = pkgs.mkShell {
  buildInputs =
    with pkgs; [
      cli
      git
      nodejs
      pkg-config
      pnpm
      pre-commit
      python3
      python3Packages.setuptools
      graphviz
      anchor
    ]
    # Linux-only deps
    ++ lib.optionals stdenv.isLinux [
      udev
      libusb1
    ]
    # macOS deps (no udev; use system frameworks)
    ++ lib.optionals stdenv.isDarwin [
      libusb1
      darwin.apple_sdk.frameworks.IOKit
      darwin.apple_sdk.frameworks.CoreFoundation
    ];
};

      }
    )
  );
}
