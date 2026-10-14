#!/usr/bin/env bash
# Replace two .NET libraries that PowerShell and the Exchange Online module ship in an affected version by
# the fixed build (Dockerfile, stage `pwsh-fetch`). The packages are downloaded and verified against a pinned
# SHA-512 by the Dockerfile; this script only unpacks them and keeps the deps.json files truthful.
#
#   patch-dotnet-libraries.sh VERSION PKCS_NUPKG XML_NUPKG POWERSHELL_DIR MODULE_NETCORE_DIR
#
# What it does
#   - POWERSHELL_DIR gets the net10.0 builds of System.Security.Cryptography.Pkcs and .Xml (PowerShell loads its
#     own copies, so these are the ones that run);
#   - MODULE_NETCORE_DIR (the module's netCore folder) gets the net8.0 build of Pkcs (the module targets net8.0);
#   - pwsh.deps.json and the module's deps.json name VERSION, with the SHA-512 of the package, so that a scanner
#     that reads them sees what is installed. The assembly version of the libraries is 10.0.0.0 in both the old
#     and the new build, which is what the .NET host resolves by, so nothing else changes.
#
# It fails (exit 1) when PowerShell or the module no longer ships the version it expects. That is on purpose: the
# pins are then reviewed, and this script is not made to pass by guessing.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 VERSION PKCS_NUPKG XML_NUPKG POWERSHELL_DIR MODULE_NETCORE_DIR" >&2
  exit 2
fi
version="$1"
pkcs_package="$2"
xml_package="$3"
powershell_dir="$4"
module_dir="$5"

powershell_deps="${powershell_dir}/pwsh.deps.json"
module_deps="${module_dir}/Microsoft.Exchange.Management.ExoPowershellGalleryModule.deps.json"
pkcs_old_powershell="10.0.10"
xml_old_powershell="10.0.10"
pkcs_old_module="10.0.0"

require() {
  grep -q -F -- "$2" "$1" || {
    echo "patch-dotnet-libraries: $1 does not contain $2; PowerShell or the module changed, review the pins" >&2
    exit 1
  }
}
require "${powershell_deps}" "\"System.Security.Cryptography.Pkcs/${pkcs_old_powershell}\""
require "${powershell_deps}" "\"System.Security.Cryptography.Xml/${xml_old_powershell}\""
require "${module_deps}" "\"System.Security.Cryptography.Pkcs/${pkcs_old_module}\""
for file in System.Security.Cryptography.Pkcs.dll System.Security.Cryptography.Xml.dll; do
  test -f "${powershell_dir}/${file}"
done
test -f "${module_dir}/System.Security.Cryptography.Pkcs.dll"

# The files.
unzip -q -j -o "${pkcs_package}" lib/net10.0/System.Security.Cryptography.Pkcs.dll -d "${powershell_dir}"
unzip -q -j -o "${xml_package}" lib/net10.0/System.Security.Cryptography.Xml.dll -d "${powershell_dir}"
unzip -q -j -o "${pkcs_package}" lib/net8.0/System.Security.Cryptography.Pkcs.dll -d "${module_dir}"

# The deps.json files. The library entries are pretty printed, so the range of one entry ends at its first `}`.
pkcs_hash="$(openssl dgst -sha512 -binary "${pkcs_package}" | base64 -w0)"
xml_hash="$(openssl dgst -sha512 -binary "${xml_package}" | base64 -w0)"

patch_library() { # deps-file, Name, lower-case name, old version, hash
  local deps="$1" name="$2" lower="$3" old="$4" hash="$5"
  sed -i \
    -e "s|\"${name}/${old}\"|\"${name}/${version}\"|g" \
    -e "s|\"${name}\": \"${old}\"|\"${name}\": \"${version}\"|g" \
    -e "s|\"${lower}/${old}\"|\"${lower}/${version}\"|g" \
    -e "s|${lower}\.${old}\.nupkg\.sha512|${lower}.${version}.nupkg.sha512|g" \
    "${deps}"
  sed -i -e "/\"${name}\/${version}\": {/,/}/ s|\"sha512\": \"[^\"]*\"|\"sha512\": \"sha512-${hash}\"|" "${deps}"
}
patch_library "${powershell_deps}" System.Security.Cryptography.Pkcs system.security.cryptography.pkcs "${pkcs_old_powershell}" "${pkcs_hash}"
patch_library "${powershell_deps}" System.Security.Cryptography.Xml system.security.cryptography.xml "${xml_old_powershell}" "${xml_hash}"
patch_library "${module_deps}" System.Security.Cryptography.Pkcs system.security.cryptography.pkcs "${pkcs_old_module}" "${pkcs_hash}"

# Nothing of the old versions is left, and the fixed ones are named with the right hash.
if grep -E "\"System\.Security\.Cryptography\.(Pkcs|Xml)(/|\": \")(${pkcs_old_powershell}|${pkcs_old_module})\"" "${powershell_deps}" "${module_deps}"; then
  echo "patch-dotnet-libraries: an old version is left in a deps.json" >&2
  exit 1
fi
require "${powershell_deps}" "\"System.Security.Cryptography.Pkcs/${version}\""
require "${powershell_deps}" "\"System.Security.Cryptography.Xml/${version}\""
require "${module_deps}" "\"System.Security.Cryptography.Pkcs/${version}\""
require "${powershell_deps}" "sha512-${pkcs_hash}"
require "${powershell_deps}" "sha512-${xml_hash}"
require "${module_deps}" "sha512-${pkcs_hash}"
echo "patch-dotnet-libraries: Pkcs and Xml ${version} installed"
