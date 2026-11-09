"""Run real protocol/database tests and save machine-readable evidence."""
import argparse
from datetime import datetime, timezone
import json
import sys
import unittest

from common import ROOT
sys.path.insert(0,str(ROOT / 'tests'))
from test_week1 import ContractTests, MqttTests, DatabaseTests, AggregateTests

class EvidenceResult(unittest.TextTestResult):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs); self.evidence=[]
    def addSuccess(self,test):
        super().addSuccess(test); self.evidence.append({'test':test.id(),'result':'PASS'})
    def addFailure(self,test,err):
        super().addFailure(test,err); self.evidence.append({'test':test.id(),'result':'FAIL','error':str(err[1])})
    def addError(self,test,err):
        super().addError(test,err); self.evidence.append({'test':test.id(),'result':'ERROR','error':str(err[1])})

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--database',action='store_true')
    args=parser.parse_args()
    suites=[ContractTests,MqttTests]+([DatabaseTests,AggregateTests] if args.database else [])
    suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(cls) for cls in suites)
    result=unittest.TextTestRunner(verbosity=2,resultclass=EvidenceResult).run(suite)
    report={'executed_at_utc':datetime.now(timezone.utc).isoformat(),
            'scope':'contracts+mqtt+timescaledb' if args.database else 'contracts+mqtt',
            'tests_run':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),
            'successful':result.wasSuccessful(),'tests':result.evidence}
    path=ROOT / 'output/verification' / ('verification-full.json' if args.database else 'verification-mqtt.json')
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    sys.exit(0 if result.wasSuccessful() else 1)

if __name__=='__main__': main()
