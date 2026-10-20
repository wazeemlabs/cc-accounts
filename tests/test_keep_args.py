"""Tests for libexec/cca-keep-args against a saved `claude --help`.
Run: python3 -m unittest discover -s tests"""
import importlib.machinery
import importlib.util
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader('keep_args', str(HERE.parent / 'libexec' / 'cca-keep-args'))
spec = importlib.util.spec_from_loader('keep_args', loader)
keep_args = importlib.util.module_from_spec(spec)
loader.exec_module(keep_args)
TABLE = keep_args.arities((HERE / 'fixtures' / 'claude-help.txt').read_text())


def keep(*args):
    return keep_args.keep(list(args), TABLE)


class Arities(unittest.TestCase):
    def test_reads_each_kind_of_option(self):
        self.assertEqual(TABLE['--model'], ('--model', 'one'))
        self.assertEqual(TABLE['--add-dir'], ('--add-dir', 'many'))
        self.assertEqual(TABLE['-r'], ('--resume', 'optional'))
        self.assertEqual(TABLE['--dangerously-skip-permissions'], ('--dangerously-skip-permissions', 'flag'))
        self.assertEqual(TABLE['--bg'], ('--background', 'flag'))
        self.assertEqual(TABLE['--allowed-tools'], ('--allowed-tools', 'many'))


class InstalledClaude(unittest.TestCase):
    def test_the_installed_claude_help_still_parses(self):
        import shutil, subprocess
        claude = shutil.which('claude')
        if claude is None:
            self.skipTest('Claude Code is not installed')
        help_text = subprocess.run([claude, '--help'], capture_output=True, text=True, check=True).stdout
        table = keep_args.arities(help_text)
        self.assertEqual(table.get('--model'), ('--model', 'one'))
        self.assertEqual(table.get('-r'), ('--resume', 'optional'))
        self.assertEqual(table.get('--add-dir'), ('--add-dir', 'many'))


class Keep(unittest.TestCase):
    def test_keeps_options_with_their_values(self):
        self.assertEqual(
            keep('--model', 'opus', '--permission-mode', 'auto', '--dangerously-skip-permissions'),
            (['--model', 'opus', '--permission-mode', 'auto', '--dangerously-skip-permissions'], []))

    def test_drops_the_prompt_wherever_it_stands(self):
        self.assertEqual(keep('fix it', '--model', 'opus'), (['--model', 'opus'], ['fix it']))
        self.assertEqual(keep('--verbose', 'fix it'), (['--verbose'], ['fix it']))

    def test_drops_session_choices_and_one_shot_options(self):
        kept, dropped = keep('-r', 'abc', '-c', '--session-id', 'u', '-w', 'feat', '--fork-session', '-p', '--model', 'x')
        self.assertEqual(kept, ['--model', 'x'])
        self.assertEqual(dropped, ['-r', 'abc', '-c', '--session-id', 'u', '-w', 'feat', '--fork-session', '-p'])

    def test_an_optional_value_is_not_taken_from_the_next_option(self):
        self.assertEqual(keep('--resume', '--model', 'x'), (['--model', 'x'], ['--resume']))

    def test_variadic_values_run_to_the_next_option(self):
        self.assertEqual(keep('--add-dir', '/a', '/b', '--verbose'), (['--add-dir', '/a', '/b', '--verbose'], []))

    def test_inline_values(self):
        self.assertEqual(keep('--model=opus', '--resume=abc'), (['--model=opus'], ['--resume=abc']))

    def test_everything_after_a_double_dash_is_prompt(self):
        self.assertEqual(keep('--verbose', '--', '--model', 'x'), (['--verbose'], ['--', '--model', 'x']))

    def test_an_unknown_option_and_a_possible_value_are_dropped_not_guessed(self):
        self.assertEqual(keep('--mystery', 'thing', '--verbose'), (['--verbose'], ['--mystery', 'thing']))

    def test_empty(self):
        self.assertEqual(keep(), ([], []))


if __name__ == '__main__':
    unittest.main()
