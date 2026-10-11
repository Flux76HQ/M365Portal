"""Tests for scripts/resolve_action_pins.py (FR-A-174, SA-01, T-A-250).

No network: the parser and the version choice run on canned `git ls-remote --tags` output. The
rules under test: an annotated tag resolves to its peeled `^{}` commit (the object the tag object
points at is not a commit), a lightweight tag resolves to its own object, pre-releases are ignored,
the highest stable tag wins (numerically, so v10 beats v9), a tag that is missing is an error.
"""
import unittest

import resolve_action_pins as pins

A = "a" * 40
B = "b" * 40
C = "c" * 40
D = "d" * 40
E = "e" * 40

CANNED = "\n".join([
    f"{A}\trefs/tags/v1.0.0",
    f"{B}\trefs/tags/v1.2.0",              # annotated: tag object B, commit C
    f"{C}\trefs/tags/v1.2.0^{{}}",
    f"{D}\trefs/tags/v1.10.0",             # lightweight
    f"{E}\trefs/tags/v2.0.0-rc.1",         # pre-release
    f"{E}\trefs/tags/v2",                  # moving major alias, not a full version
    f"{E}\trefs/tags/nightly",
    "",
])


class ParseTests(unittest.TestCase):
    def test_annotated_tag_resolves_to_peeled_commit(self):
        self.assertEqual(pins.parse_ls_remote(CANNED)["v1.2.0"], C)

    def test_lightweight_tag_resolves_to_itself(self):
        self.assertEqual(pins.parse_ls_remote(CANNED)["v1.0.0"], A)
        self.assertEqual(pins.parse_ls_remote(CANNED)["v1.10.0"], D)

    def test_peeled_line_before_tag_line_still_wins(self):
        text = f"{C}\trefs/tags/v3.0.0^{{}}\n{B}\trefs/tags/v3.0.0\n"
        self.assertEqual(pins.parse_ls_remote(text)["v3.0.0"], C)

    def test_garbage_lines_are_ignored(self):
        self.assertEqual(pins.parse_ls_remote("warning: nope\n\nxyz\trefs/tags/v1.0.0\n"), {})


class ChoiceTests(unittest.TestCase):
    def test_highest_stable_wins_numerically(self):
        self.assertEqual(pins.highest_stable(pins.parse_ls_remote(CANNED)), "v1.10.0")

    def test_pre_releases_and_aliases_are_ignored(self):
        tags = {"v2.0.0-rc.1": E, "v2": E, "v1.0.0": A}
        self.assertEqual(pins.highest_stable(tags), "v1.0.0")

    def test_no_stable_tag_is_an_error(self):
        with self.assertRaises(pins.PinError):
            pins.highest_stable({"v2.0.0-rc.1": E, "nightly": E})

    def test_resolve_returns_version_and_commit(self):
        self.assertEqual(pins.resolve_from_output("o/r", CANNED), ("v1.10.0", D))

    def test_wanted_version_missing_is_an_error(self):
        with self.assertRaises(pins.PinError) as caught:
            pins.resolve_from_output("o/r", CANNED, wanted="v9.9.9")
        self.assertIn("o/r", str(caught.exception))

    def test_wanted_version_found(self):
        self.assertEqual(pins.resolve_from_output("o/r", CANNED, wanted="v1.2.0"), ("v1.2.0", C))

    def test_empty_output_is_an_error(self):
        with self.assertRaises(pins.PinError):
            pins.resolve_from_output("o/r", "")


class ManifestTests(unittest.TestCase):
    def test_manifest_lists_the_actions_of_plan_12_3(self):
        self.assertEqual(len(pins.ACTIONS), 14)
        for name in ("actions/checkout", "docker/build-push-action", "rhysd/actionlint",
                     "github/codeql-action", "sigstore/cosign-installer"):
            self.assertIn(name, pins.ACTIONS)

    def test_format_pin_line(self):
        self.assertEqual(pins.format_pin("actions/checkout", "v7.0.1", A),
                         f"actions/checkout@{A} # v7.0.1")


if __name__ == "__main__":
    unittest.main()
