# Windows PowerShell 5.1 may inherit PowerShell 7 module paths through Python.
# Use its own built-in modules in this process so Utility/Management load correctly.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $env:PSModulePath = "$PSHOME\Modules;$env:ProgramFiles\WindowsPowerShell\Modules"
}
