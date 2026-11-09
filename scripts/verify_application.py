"""Save concise machine-readable results for the actual running application."""
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tests'))
from test_application import ApplicationTests


class Result(unittest.TextTestResult):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.evidence=[]
    def addSuccess(self,test):
        super().addSuccess(test)
        self.evidence.append({'test':test.id(),'result':'PASS'})
    def addError(self,test,err):
        super().addError(test,err)
        self.evidence.append({'test':test.id(),'result':'ERROR','reason':str(err[1])})
    def addFailure(self,test,err):
        super().addFailure(test,err)
        self.evidence.append({'test':test.id(),'result':'FAIL','reason':str(err[1])})


if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(ApplicationTests)
    result=unittest.TextTestRunner(verbosity=2,resultclass=Result).run(suite)
    report={'executed_at_utc':datetime.now(timezone.utc).isoformat(),'tests_run':result.testsRun,
            'success':result.wasSuccessful(),'failures':len(result.failures),'errors':len(result.errors),'tests':result.evidence}
    target=ROOT/'output/verification/application-verification.json'
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    sys.exit(0 if result.wasSuccessful() else 1)
