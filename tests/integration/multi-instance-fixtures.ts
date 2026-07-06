// M5-L3 (Task 6) — multi-instance runtime fixtures. Parameterized by taskType:
// D1 job state is visible across tests within one file, so every test mints its
// OWN taskType (the loop-rewalk precedent) — a shared type would let a later
// test's /jobs/activate lease an earlier (failed) test's leftover jobs.

/**
 * Parallel cardinality MI on a serviceTask: Start → mi1 (loopCardinality 3,
 * easy-bpmn:multiInstance outputVariable="results" — cardinality-only + an ext
 * binding WITHOUT a collection is legal since Task 2) → End.
 */
export const MI_PAR_TASK_BPMN = (taskType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_par" targetNamespace="x">
  <bpmn:process id="P_mi_par" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:serviceTask id="mi1" name="Charge each">
      <bpmn:extensionElements>
        <easy-bpmn:taskDefinition type="${taskType}" retries="1"/>
        <easy-bpmn:multiInstance outputVariable="results"/>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">3</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * Sequential collection MI: iterates `orders`, each iteration sees
 * `order` (elementVariable) + `loopCounter`; aggregates into `results`.
 */
export const MI_SEQ_COLL_BPMN = (taskType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_seq" targetNamespace="x">
  <bpmn:process id="P_mi_seq" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:serviceTask id="mi1" name="Process each order">
      <bpmn:extensionElements>
        <easy-bpmn:taskDefinition type="${taskType}" retries="1"/>
        <easy-bpmn:multiInstance collection="orders" elementVariable="order" outputVariable="results"/>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="true"/>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * The N=0 fixture: a parallel collection MI over `items` — started with
 * `items: []` the activation settles 'all' immediately and the instance
 * completes on the start-drive with `results: []`.
 */
export const MI_ZERO_BPMN = (taskType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_zero" targetNamespace="x">
  <bpmn:process id="P_mi_zero" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:serviceTask id="mi1" name="Maybe nothing">
      <bpmn:extensionElements>
        <easy-bpmn:taskDefinition type="${taskType}" retries="1"/>
        <easy-bpmn:multiInstance collection="items" outputVariable="results"/>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false"/>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * The cap fixture: loopCardinality 999 > effectiveMiCap = min(MAX_MI_CARDINALITY
 * = 200, floor(STEP_BUDGET_SOFT 20000 / (bodyStepCost 1 * 4)) = 5000) = 200 →
 * a terminal `miCardinality` incident at activation, ZERO jobs created.
 */
export const MI_CAP_BPMN = (taskType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_cap" targetNamespace="x">
  <bpmn:process id="P_mi_cap" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:serviceTask id="mi1" name="Bomb">
      <bpmn:extensionElements>
        <easy-bpmn:taskDefinition type="${taskType}" retries="1"/>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">999</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * MI inside an M4 parallel branch (Test 6): a SESE AND fork/join where branch A
 * carries the MI task (loopCardinality 2, outputVariable="results") and branch B
 * a plain task — the aggregation must land in branch A's overlay and fold up to
 * root at the join.
 */
export const MI_IN_PARALLEL_BRANCH_BPMN = (miTaskType: string, plainTaskType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_branch" targetNamespace="x">
  <bpmn:process id="P_mi_branch" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>s0</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="s0" sourceRef="S" targetRef="fork"/>
    <bpmn:parallelGateway id="fork"><bpmn:incoming>s0</bpmn:incoming><bpmn:outgoing>fa</bpmn:outgoing><bpmn:outgoing>fb</bpmn:outgoing></bpmn:parallelGateway>
    <bpmn:sequenceFlow id="fa" sourceRef="fork" targetRef="mi1"/>
    <bpmn:sequenceFlow id="fb" sourceRef="fork" targetRef="plain1"/>
    <bpmn:serviceTask id="mi1" name="Charge each">
      <bpmn:extensionElements>
        <easy-bpmn:taskDefinition type="${miTaskType}" retries="1"/>
        <easy-bpmn:multiInstance outputVariable="results"/>
      </bpmn:extensionElements>
      <bpmn:incoming>fa</bpmn:incoming>
      <bpmn:outgoing>ja</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">2</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="plain1" name="Sibling">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="${plainTaskType}" retries="1"/></bpmn:extensionElements>
      <bpmn:incoming>fb</bpmn:incoming>
      <bpmn:outgoing>jb</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="ja" sourceRef="mi1" targetRef="join"/>
    <bpmn:sequenceFlow id="jb" sourceRef="plain1" targetRef="join"/>
    <bpmn:parallelGateway id="join"><bpmn:incoming>ja</bpmn:incoming><bpmn:incoming>jb</bpmn:incoming><bpmn:outgoing>s1</bpmn:outgoing></bpmn:parallelGateway>
    <bpmn:sequenceFlow id="s1" sourceRef="join" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>s1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
