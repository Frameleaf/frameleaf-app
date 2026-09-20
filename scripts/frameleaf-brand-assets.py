#!/usr/bin/env python3
"""Build and verify the Frameleaf brand-source preservation inventory."""

import argparse
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import re
import stat
import sys
import xml.etree.ElementTree as ET


INVENTORY_PATH = Path("design/frameleaf/brand-kit/brand-asset-inventory.json")
MANIFEST_PATH = Path("design/frameleaf/brand-kit/manifest.json")
GUIDE_PATH = Path("docs/docs/developer/frameleaf-plan/06-brand-assets.md")
BACKLOG_PATH = Path("docs/docs/developer/frameleaf-plan/backlog.json")
JIRA_MAP_PATH = Path("docs/docs/developer/frameleaf-plan/jira-map.json")
SOURCE_MANIFEST_PATH = Path("design/frameleaf/source-manifest.json")

SVG_NAMESPACE = "http://www.w3.org/2000/svg"
XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"
XLINK_NAMESPACE = "http://www.w3.org/1999/xlink"
MANIFEST_SHA256 = "768b1780125b5548becf87c43b12092eb695c00a1d088883d58b1f18462ca7a7"
SOURCE_MANIFEST_SHA256 = "66944718daf617fd4ed1b60004fd47ab2ccbf1f59c8e14d99d295327683b3b25"

SUPPLIED_SOURCES = {
    "README.txt": (2089, "1255df3da15dc546ca160f50583a7e37044a8ef733d0768a0f28ac594688f7ff"),
    "frameleaf-app-icon.svg": (2126, "1f871ae45f6702e775fcd75fa67c8c38b53f328b13a672af98ecf23a12abfc94"),
    "frameleaf-dark-styleboard.svg": (200233, "7c633f7095f9e647a841ec567dbce50229095e5c0da3554ad1edae250b78d6ea"),
    "frameleaf-logo-dark-tagline.svg": (13971, "9b8c1286f289874a2c40c2d75d0ad168152bd1ee91916da3d4d6e47ae56a98f7"),
    "frameleaf-logo-dark.svg": (6442, "f99cfa4ef5c10da51cfa54627f12ad6e7eba4decb59fe0829f06f0e0978a609b"),
    "frameleaf-logo-white.svg": (5306, "1ab00db27ed39ea9e3de7374bf324c88a097fc684b25ecfeb7695a504b92be45"),
    "frameleaf-symbol-white.svg": (1325, "a32b14f656a7ddef255190aacc18b4575b0966bd79f96db93d4fd8153525602b"),
    "frameleaf-symbol.svg": (2165, "beaa5788267b8eb34167dc89c13df024b33f8c02bc4914f9ac5453f10393e7b2"),
}

REFERENCE_SPECS = (
    ("design/frameleaf/README.md", "approved-design-handoff"),
    ("design/frameleaf/INTERACTION-REQUIREMENTS.md", "approved-interaction-contract"),
    ("design/frameleaf/tokens.json", "approved-token-reference"),
    ("design/frameleaf/template/README.md", "approved-prototype-usage-contract"),
    ("design/frameleaf/references/README.md", "approved-visual-reference-contract"),
    ("design/frameleaf/mark.png", "historical-raster-reference-not-authority"),
    ("design/frameleaf/template/public/media/brand.png", "historical-raster-reference-not-authority"),
)

COMPATIBILITY_SENTINELS = (
    ("mobile/pubspec.yaml", "yaml-root-name", "immich_mobile"),
    ("mobile/pubspec.yaml", "yaml-image-path-android", "assets/immich-logo.png"),
    ("packages/sdk/package.json", "json-name", "@immich/sdk"),
    ("server/package.json", "json-name", "immich"),
    ("machine-learning/pyproject.toml", "toml-project-name", "immich-ml"),
    ("machine-learning/pyproject.toml", "toml-build-includes", "immich_ml"),
    ("web/src/routes/+layout.svelte", "svelte-import", "@immich/sdk"),
)

OWNERS = {
    "FN-201": {"jiraId": "23644", "jiraKey": "FL-29", "dependencies": ["FN-103"], "paths": ["design/frameleaf/tokens.json", "web/src/lib/frameleaf/tokens.css", "web/src/lib/components/frameleaf", "mobile/lib/frameleaf/frameleaf_tokens.dart", "design/frameleaf/brand-kit/manifest.json", "docs/docs/developer/frameleaf-plan/06-brand-assets.md"]},
    "REL-101": {"jiraId": "23745", "jiraKey": "FL-130", "dependencies": ["REL-201"], "paths": ["mobile/frameleaf-identity.example.json", "scripts/frameleaf-mobile-identity.py", "scripts/frameleaf-mobile-identity-test.py", "mobile/android/app/build.gradle", "mobile/ios/Runner.xcodeproj", "mobile/ios/Runner/Runner.entitlements", "mobile/ios/fastlane", "design/frameleaf/brand-kit/manifest.json", "design/frameleaf/brand-kit/frameleaf-app-icon.svg", "design/frameleaf/brand-kit/frameleaf-symbol-white.svg", "docs/docs/developer/frameleaf-plan/06-brand-assets.md"]},
    "REL-102": {"jiraId": "23746", "jiraKey": "FL-131", "dependencies": ["MOB-101", "REL-101"], "paths": ["mobile/lib/services/oauth.service.dart", "mobile/lib/widgets/forms/login/login_form.dart", "mobile/lib/services/auth.service.dart", "mobile/lib/providers/auth.provider.dart", "server/src/services/auth.service.ts", "server/src/controllers/oauth.controller.ts", "server/src/dtos/config.dto.ts", "design/frameleaf/brand-kit/frameleaf-logo-dark.svg", "design/frameleaf/brand-kit/frameleaf-symbol.svg", "docs/docs/developer/frameleaf-plan/06-brand-assets.md"]},
    "REL-103": {"jiraId": "23750", "jiraKey": "FL-135", "dependencies": ["MOB-101", "REL-101"], "paths": ["design/frameleaf", "mobile/assets/frameleaf-mark.png", "mobile/pubspec.yaml", "mobile/android/fastlane/metadata", "mobile/ios/Runner/Assets.xcassets", "mobile/ios/ShareExtension", "mobile/ios/WidgetExtension", "mobile/lib/utils/licenses.dart", "mobile/lib/frameleaf/frameleaf_links.dart", "web/src/lib/components/frameleaf", "design/frameleaf/brand-kit", "design/frameleaf/brand-kit/manifest.json", "docs/docs/developer/frameleaf-plan/06-brand-assets.md"]},
}


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path):
    return json.loads(path.read_text(), object_pairs_hook=reject_duplicate_keys)


def digest(path):
    data = path.read_bytes()
    return len(data), hashlib.sha256(data).hexdigest()


def exact_keys(value, keys, context):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(f"{context}: expected exactly {sorted(keys)}, got {sorted(value) if isinstance(value, dict) else type(value).__name__}")


def strip_line_comments(text, marker="#"):
    lines = []
    for line in text.splitlines():
        quote = None
        escaped = False
        kept = []
        for character in line:
            if escaped:
                kept.append(character)
                escaped = False
            elif character == "\\" and quote == '"':
                kept.append(character)
                escaped = True
            elif character in "'\"":
                kept.append(character)
                quote = None if quote == character else character if quote is None else quote
            elif character == marker and quote is None:
                break
            else:
                kept.append(character)
        lines.append("".join(kept))
    return "\n".join(lines)


def compatibility_value(root, path_text, parser):
    path = root / path_text
    text = path.read_text()
    if parser == "json-name":
        value = load_json(path)
        return value.get("name")
    if parser.startswith("yaml-"):
        active = strip_line_comments(text)
        if parser == "yaml-root-name":
            matches = re.findall(r"^name\s*:\s*['\"]?([^'\"\s]+)['\"]?\s*$", active, re.M)
        else:
            matches = re.findall(r"^\s*image_path_android\s*:\s*['\"]?([^'\"\s#]+)['\"]?\s*$", active, re.M)
        return matches[0] if len(matches) == 1 else None
    if parser.startswith("toml-"):
        active = strip_line_comments(text)
        sections = {}
        section = ""
        for line in active.splitlines():
            line = line.strip()
            if not line:
                continue
            match = re.fullmatch(r"\[([^]]+)\]", line)
            if match:
                section = match.group(1)
                continue
            match = re.fullmatch(r"([A-Za-z0-9_-]+)\s*=\s*(.+)", line)
            if match:
                if match.group(1) in sections.setdefault(section, {}):
                    raise ValueError(f"{path_text}: duplicate TOML key in [{section}]: {match.group(1)}")
                sections.setdefault(section, {})[match.group(1)] = match.group(2).strip()
        if parser == "toml-project-name":
            raw = sections.get("project", {}).get("name", "")
            return raw[1:-1] if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"" else None
        required_sections = ("tool.hatch.build.targets.sdist", "tool.hatch.build.targets.wheel")
        values = [re.findall(r"['\"]([^'\"]+)['\"]", sections.get(name, {}).get("include", "")) for name in required_sections]
        return values[0] if values and all(value == values[0] for value in values) else []
    if parser == "svelte-import":
        active = re.sub(r"<!--.*?-->|/\*.*?\*/|//[^\n]*", "", text, flags=re.S)
        return re.findall(r"^\s*(?:import\s+(?:[^;\n]*?\s+from\s+)?|export\s+[^;\n]*?\s+from\s+)['\"]([^'\"]+)['\"]", active, re.M)
    raise ValueError(f"unsupported compatibility parser: {parser}")


def local_name(name):
    return name.rsplit("}", 1)[-1]


def svg_facts(path):
    data = path.read_bytes()
    text = data.decode("utf-8")
    processing_instructions = list(re.finditer(r"<\?.*?\?>", text, re.S))
    xml_declaration = re.match(r"\ufeff?<\?xml(?:\s[^?]*)?\?>", text)
    for instruction in processing_instructions:
        if xml_declaration and instruction.span() == xml_declaration.span():
            continue
        raise ValueError(f"{path}: XML processing instructions other than the declaration are prohibited")
    if re.search(r"<!DOCTYPE|<!ENTITY", text, re.I):
        raise ValueError(f"{path}: DTD and entity declarations are prohibited")
    namespaces = list(ET.iterparse(io.BytesIO(data), events=("start-ns",)))
    allowed_namespaces = {
        ("", SVG_NAMESPACE),
        ("xlink", XLINK_NAMESPACE),
        ("inkscape", "http://www.inkscape.org/namespaces/inkscape"),
    }
    if any(namespace not in allowed_namespaces for _, namespace in namespaces):
        raise ValueError(f"{path}: namespace declaration differs from the reviewed SVG/xlink/Inkscape set")
    root = ET.fromstring(data)
    if root.tag != f"{{{SVG_NAMESPACE}}}svg":
        raise ValueError(f"{path}: root must be an SVG element in the SVG namespace")
    elements = list(root.iter())
    counts = Counter(local_name(element.tag) for element in elements)
    ids = []
    references = []
    event_handlers = 0
    font_references = 0
    external_references = 0
    for element in elements:
        if not isinstance(element.tag, str) or not element.tag.startswith(f"{{{SVG_NAMESPACE}}}"):
            raise ValueError(f"{path}: non-SVG element namespace is prohibited: {element.tag}")
        if local_name(element.tag) == "style":
            style = element.text or ""
            if re.search(r"@import\b", style, re.I):
                raise ValueError(f"{path}: CSS @import is prohibited")
            if "\\" in style or "/*" in style or "*/" in style or re.search(r"@", style):
                raise ValueError(f"{path}: escaped, commented or at-rule CSS is prohibited")
            for match in re.findall(r"url\(([^)]+)\)", style, re.I):
                target = match.strip(" '\"")
                if target.startswith("#"):
                    references.append(target[1:])
                else:
                    external_references += 1
        for raw_name, value in element.attrib.items():
            if raw_name.startswith("{"):
                namespace = raw_name[1:].split("}", 1)[0]
                if namespace not in {XML_NAMESPACE, XLINK_NAMESPACE}:
                    raise ValueError(f"{path}: attribute namespace is prohibited: {namespace}")
            name = local_name(raw_name)
            if name == "id":
                ids.append(value)
            if name.lower().startswith("on"):
                event_handlers += 1
            if "font" in name.lower() or re.search(r"font(?:-family)?\s*:", value, re.I):
                font_references += 1
            if name == "href":
                if value.startswith("#"):
                    references.append(value[1:])
                else:
                    external_references += 1
            if name == "style" and re.search(r"@import\b", value, re.I):
                raise ValueError(f"{path}: CSS @import is prohibited")
            if name == "style" and ("\\" in value or "/*" in value or "*/" in value or re.search(r"@", value)):
                raise ValueError(f"{path}: escaped, commented or at-rule CSS is prohibited")
            for match in re.findall(r"url\(([^)]+)\)", value):
                target = match.strip(" '\"")
                if target.startswith("#"):
                    references.append(target[1:])
                else:
                    external_references += 1
    if external_references:
        raise ValueError(f"{path}: external SVG/CSS references are prohibited")
    duplicate_ids = sorted(value for value, count in Counter(ids).items() if count > 1)
    if duplicate_ids:
        raise ValueError(f"{path}: duplicate SVG IDs: {', '.join(duplicate_ids)}")
    unresolved = sorted(set(references) - set(ids))
    animation_count = sum(counts.get(name, 0) for name in ("animate", "animateMotion", "animateTransform", "set"))
    if animation_count:
        raise ValueError(f"{path}: animation elements are prohibited")
    title = next((element.text or "" for element in elements if local_name(element.tag) == "title"), "").strip()
    colors = sorted(set(match.upper() for match in re.findall(r"#[0-9A-Fa-f]{6}\b", text)))
    return {
        "audit": {
            "embeddedImages": counts.get("image", 0),
            "eventHandlers": event_handlers,
            "externalReferences": external_references,
            "fontReferences": font_references,
            "foreignObjects": counts.get("foreignObject", 0),
            "liveText": counts.get("text", 0),
            "scripts": counts.get("script", 0),
            "unresolvedInternalReferences": len(unresolved),
        },
        "colors": colors,
        "elementCounts": dict(sorted(counts.items())),
        "height": int(root.attrib["height"]),
        "internalReferenceCount": len(references),
        "title": title,
        "viewBox": root.attrib["viewBox"],
        "width": int(root.attrib["width"]),
    }


def validate_manifest(root):
    manifest_path = root / MANIFEST_PATH
    manifest = load_json(manifest_path)
    exact_keys(manifest, {"audit", "authority", "declaredBasePalette", "files", "importedAt", "preservation", "product", "rightsEvidence", "schemaVersion", "source"}, "brand manifest")
    exact_keys(manifest["audit"], {"archiveEntries", "executableFiles", "method", "pathTraversal", "regularFiles", "svgFiles", "symlinks"}, "brand manifest audit")
    exact_keys(manifest["declaredBasePalette"], {"canvasGradient", "leafGreen", "lightGray", "skyBlue", "teal"}, "brand manifest palette")
    exact_keys(manifest["source"], {"archiveName", "bytes", "rootPrefixRemoved", "sha256", "sourceFileCount"}, "brand manifest source")
    if digest(manifest_path) != (11927, MANIFEST_SHA256):
        raise ValueError("brand manifest differs from the reviewed immutable authority")
    if manifest.get("schemaVersion") != 1 or manifest.get("product") != "Frameleaf":
        raise ValueError("brand manifest identity/schema is invalid")
    files = manifest.get("files")
    if not isinstance(files, list) or len(files) != 8:
        raise ValueError("brand manifest must contain exactly eight supplied files")
    for entry in files:
        expected_keys = {"archivePath", "bytes", "intendedUsage", "path", "sha256"}
        if str(entry.get("path", "")).endswith(".svg"):
            expected_keys.add("svg")
        exact_keys(entry, expected_keys, f"brand manifest file {entry.get('path')}")
        if "svg" in entry:
            exact_keys(entry["svg"], {"audit", "colors", "elementCounts", "height", "internalReferenceCount", "title", "viewBox", "width"}, f"{entry['path']} SVG facts")
            exact_keys(entry["svg"]["audit"], {"embeddedImages", "eventHandlers", "externalReferences", "fontReferences", "foreignObjects", "liveText", "scripts", "unresolvedInternalReferences"}, f"{entry['path']} SVG audit")
    paths = [entry.get("path") for entry in files]
    archive_paths = [entry.get("archivePath") for entry in files]
    hashes = [entry.get("sha256") for entry in files]
    for label, values in (("path", paths), ("archive path", archive_paths), ("source hash", hashes)):
        if None in values or len(values) != len(set(values)):
            raise ValueError(f"brand manifest has a missing or duplicate {label}")
    expected_sources = {name: values for name, values in SUPPLIED_SOURCES.items()}
    actual_sources = {entry["path"]: (entry["bytes"], entry["sha256"]) for entry in files}
    if actual_sources != expected_sources:
        raise ValueError("brand manifest supplied identities/hashes differ from reviewed evidence")
    kit = manifest_path.parent
    required_members = set(paths) | {"manifest.json"}
    allowed_members = required_members | {INVENTORY_PATH.name}
    actual_members = []
    for path in kit.rglob("*"):
        relative = path.relative_to(kit).as_posix()
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not stat.S_ISREG(mode) or "/" in relative or relative not in allowed_members:
            raise ValueError(f"brand-kit contains a non-allowlisted member: {relative}")
        actual_members.append(relative)
    if not required_members.issubset(actual_members):
        raise ValueError(f"brand-kit is missing required members: {sorted(required_members - set(actual_members))}")
    svg_count = 0
    for entry in files:
        path = kit / entry["path"]
        size, sha256 = digest(path)
        if size != entry.get("bytes") or sha256 != entry.get("sha256"):
            raise ValueError(f"{entry['path']}: supplied source bytes/hash changed")
        if entry["path"].endswith(".svg"):
            svg_count += 1
            facts = svg_facts(path)
            if facts != entry.get("svg"):
                raise ValueError(f"{entry['path']}: SVG facts differ from the immutable manifest")
            if any(facts["audit"].values()):
                raise ValueError(f"{entry['path']}: prohibited or unresolved SVG content")
    expected_audit = {
        "archiveEntries": 8,
        "executableFiles": 0,
        "pathTraversal": 0,
        "regularFiles": 8,
        "svgFiles": 7,
        "symlinks": 0,
    }
    for key, value in expected_audit.items():
        if manifest.get("audit", {}).get(key) != value:
            raise ValueError(f"manifest audit {key} must equal {value}")
    if svg_count != 7 or manifest.get("source", {}).get("sourceFileCount") != 8:
        raise ValueError("manifest source/SVG counts are inconsistent")
    return manifest


def validate_source_manifest(root, manifest):
    path = root / SOURCE_MANIFEST_PATH
    size, sha256 = digest(path)
    if (size, sha256) != (55157, SOURCE_MANIFEST_SHA256):
        raise ValueError("design source manifest differs from the reviewed immutable authority")
    source_manifest = load_json(path)
    exact_keys(source_manifest, {"schemaVersion", "capturedAt", "sourceState", "repository", "sourceCheckoutHead", "packagingBase", "issue", "productionParity", "files", "excluded", "testScope"}, "design source manifest")
    entries = {}
    for entry in source_manifest["files"]:
        exact_keys(entry, {"source", "path", "sourceSha256", "sha256", "bytes", "modifiedForPortability"}, f"design source entry {entry.get('path')}")
        if entry["path"] in entries:
            raise ValueError(f"duplicate design source path: {entry['path']}")
        entries[entry["path"]] = entry
    for entry in manifest["files"]:
        expected = {"source": f"design/frameleaf/brand-kit/{entry['path']}", "path": f"brand-kit/{entry['path']}", "sourceSha256": entry["sha256"], "sha256": entry["sha256"], "bytes": entry["bytes"], "modifiedForPortability": False}
        if entries.get(expected["path"]) != expected:
            raise ValueError(f"source manifest does not bind exact supplied source: {entry['path']}")
    manifest_entry = {"source": str(MANIFEST_PATH), "path": "brand-kit/manifest.json", "sourceSha256": MANIFEST_SHA256, "sha256": MANIFEST_SHA256, "bytes": 11927, "modifiedForPortability": False}
    if entries.get("brand-kit/manifest.json") != manifest_entry:
        raise ValueError("source manifest does not bind the immutable brand manifest")
    return {"path": str(SOURCE_MANIFEST_PATH), "bytes": size, "sha256": sha256}


def build_inventory(root):
    manifest = validate_manifest(root)
    source_manifest = validate_source_manifest(root, manifest)
    originals = []
    for entry in manifest["files"]:
        originals.append({
            "id": f"supplied:{entry['path']}",
            "path": f"design/frameleaf/brand-kit/{entry['path']}",
            "kind": "supplied-vector" if entry["path"].endswith(".svg") else "supplied-provenance",
            "bytes": entry["bytes"],
            "sha256": entry["sha256"],
            "status": "authoritative-source-not-runtime-implementation",
        })
    references = []
    for path_text, role in REFERENCE_SPECS:
        path = root / path_text
        size, sha256 = digest(path)
        references.append({"id": f"reference:{path_text}", "path": path_text, "role": role,
            "bytes": size, "sha256": sha256, "status": "reference-not-production-qualification"})
    sentinels = []
    for path_text, parser, expected_value in COMPATIBILITY_SENTINELS:
        value = compatibility_value(root, path_text, parser)
        valid = expected_value in value if isinstance(value, list) else value == expected_value
        if not valid:
            raise ValueError(f"effective compatibility identity removed from {path_text}: {expected_value}")
        sentinels.append({"path": path_text, "parser": parser, "expectedValue": expected_value})
    backlog = load_json(root / BACKLOG_PATH)
    jira = load_json(root / JIRA_MAP_PATH)
    by_id = {item["id"]: item for item in backlog["items"]}
    if len(by_id) != len(backlog["items"]):
        raise ValueError("backlog contains duplicate owner identities")
    ownership = []
    for plan_id, expected in OWNERS.items():
        item = by_id.get(plan_id)
        mapping = jira["issues"].get(plan_id)
        if not item or not mapping:
            raise ValueError(f"missing backlog/Jira owner: {plan_id}")
        if item.get("status") != "planned-not-qualified" or item.get("dependencies") != expected["dependencies"]:
            raise ValueError(f"{plan_id}: dependencies/status differ from the reviewed brand contract")
        if item.get("type") != "story" or item.get("paths") != expected["paths"]:
            raise ValueError(f"{plan_id}: type/owner paths differ from the reviewed brand contract")
        expected_url = f"https://heroit.atlassian.net/browse/{expected['jiraKey']}"
        if mapping != {"id": expected["jiraId"], "key": expected["jiraKey"], "url": expected_url}:
            raise ValueError(f"{plan_id}: Jira identity differs from the reviewed brand contract")
        ownership.append({"planId": plan_id, "type": item["type"], "jiraId": mapping["id"],
            "jiraKey": mapping["key"], "jiraUrl": mapping["url"], "dependencies": item["dependencies"],
            "paths": item["paths"], "status": item["status"]})
    manifest_size, manifest_hash = digest(root / MANIFEST_PATH)
    supplied_ledger = hashlib.sha256(json.dumps(originals, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    reference_ledger = hashlib.sha256(json.dumps(references, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return {
        "schemaVersion": 1,
        "product": "Frameleaf",
        "assessment": "Supplied artwork and approved references are preserved; no production web/native integration or release qualification is claimed.",
        "manifest": {"path": str(MANIFEST_PATH), "bytes": manifest_size, "sha256": manifest_hash},
        "sourceManifest": source_manifest,
        "digests": {"suppliedSourceLedgerSha256": supplied_ledger,
            "approvedReferenceLedgerSha256": reference_ledger},
        "counts": {"suppliedFiles": 8, "suppliedVectors": 7, "approvedReferenceDocuments": 5,
            "historicalRasterReferences": 2, "generatedDerivatives": 0, "productionConsumers": 0,
            "nativeConsumers": 0},
        "qualification": {"sourceIntegrityReviewed": True, "artworkAuthorityRecorded": True,
            "webIntegrated": False, "nativeIntegrated": False, "productionQualified": False,
            "releaseQualified": False},
        "suppliedSources": originals,
        "approvedReferences": references,
        "expectedDuplicateContent": [{"sha256": references[-1]["sha256"],
            "paths": [references[-2]["path"], references[-1]["path"]],
            "reason": "The portable template retained the historical generated prototype raster byte-for-byte; neither copy is production artwork authority."}],
        "ownership": ownership,
        "compatibilitySentinels": sentinels,
        "policies": {"globalImmichStringReplacementProhibited": True, "suppliedSourceMutationProhibited": True,
            "unknownBrandKitMembersProhibited": True, "derivativesRequireSeparateIdentityAndProvenance": True},
    }


def validate_document(root):
    text = (root / GUIDE_PATH).read_text()
    required = (
        "seven SVGs",
        "authoritative Frameleaf artwork",
        "Do not run SVG formatters or optimizers",
        "does not claim production integration, native qualification or release readiness",
        "Do not globally replace `immich`",
        "brand-asset-inventory.json",
    )
    for value in required:
        if value not in text:
            raise ValueError(f"brand guide is missing required boundary: {value}")


def validate(root):
    expected = build_inventory(root)
    actual = load_json(root / INVENTORY_PATH)
    if actual != expected:
        raise ValueError("brand asset inventory is stale or contains unsupported qualification claims")
    validate_document(root)
    return expected


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path.cwd())
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--print", dest="print_inventory", action="store_true")
    args = parser.parse_args(argv)
    root = args.repository.resolve()
    try:
        inventory = validate(root) if args.check else build_inventory(root)
        if args.print_inventory:
            print(json.dumps(inventory, indent=2, sort_keys=True) + "\n", end="")
        elif args.check:
            print("Frameleaf brand contract verified: 8 supplied files (7 SVGs), 7 references, 0 derivatives, 0 qualified consumers.")
    except (KeyError, OSError, ET.ParseError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"Frameleaf brand contract failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
