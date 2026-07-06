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
 * M5-L3 Task 7 — parallel cardinality-2 MI over a SUBPROCESS body:
 * Start → mi1 (subProcess, cardinality 2) → End, with the body
 * Sb → reserve → gw (XOR: `order = "b"` → extra → Eb / default → Eb).
 * The interior gateway condition reads the ITERATION overlay (the reserve
 * worker's output lands there), so completing reserve with order:"a"/"b"
 * steers each iteration down a different interior branch.
 */
export const MI_PAR_SUB_BPMN = (reserveType: string, extraType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_par_sub" targetNamespace="x">
  <bpmn:process id="P_mi_par_sub" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:subProcess id="mi1" name="Reserve each">
      <bpmn:extensionElements>
        <easy-bpmn:multiInstance outputVariable="results"/>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">2</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
      <bpmn:startEvent id="Sb"><bpmn:outgoing>b1</bpmn:outgoing></bpmn:startEvent>
      <bpmn:sequenceFlow id="b1" sourceRef="Sb" targetRef="reserve"/>
      <bpmn:serviceTask id="reserve" name="Reserve">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="${reserveType}" retries="1"/></bpmn:extensionElements>
        <bpmn:incoming>b1</bpmn:incoming>
        <bpmn:outgoing>b2</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:sequenceFlow id="b2" sourceRef="reserve" targetRef="gw"/>
      <bpmn:exclusiveGateway id="gw" default="bDef">
        <bpmn:incoming>b2</bpmn:incoming>
        <bpmn:outgoing>bExtra</bpmn:outgoing>
        <bpmn:outgoing>bDef</bpmn:outgoing>
      </bpmn:exclusiveGateway>
      <bpmn:sequenceFlow id="bExtra" sourceRef="gw" targetRef="extra">
        <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">order = "b"</bpmn:conditionExpression>
      </bpmn:sequenceFlow>
      <bpmn:serviceTask id="extra" name="Extra">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="${extraType}" retries="1"/></bpmn:extensionElements>
        <bpmn:incoming>bExtra</bpmn:incoming>
        <bpmn:outgoing>b3</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:sequenceFlow id="b3" sourceRef="extra" targetRef="Eb"/>
      <bpmn:sequenceFlow id="bDef" sourceRef="gw" targetRef="Eb"/>
      <bpmn:endEvent id="Eb"><bpmn:incoming>b3</bpmn:incoming><bpmn:incoming>bDef</bpmn:incoming></bpmn:endEvent>
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * M5-L3 Task 7 — sequential collection MI over a SUBPROCESS body: iterates
 * `orders` one at a time (elementVariable "order"), body Sb → handle → Eb;
 * aggregates the per-iteration token overlays into `results`.
 */
export const MI_SEQ_SUB_BPMN = (taskType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_seq_sub" targetNamespace="x">
  <bpmn:process id="P_mi_seq_sub" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:subProcess id="mi1" name="Handle each order">
      <bpmn:extensionElements>
        <easy-bpmn:multiInstance collection="orders" elementVariable="order" outputVariable="results"/>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="true"/>
      <bpmn:startEvent id="Sb"><bpmn:outgoing>b1</bpmn:outgoing></bpmn:startEvent>
      <bpmn:sequenceFlow id="b1" sourceRef="Sb" targetRef="handle"/>
      <bpmn:serviceTask id="handle" name="Handle">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="${taskType}" retries="1"/></bpmn:extensionElements>
        <bpmn:incoming>b1</bpmn:incoming>
        <bpmn:outgoing>b2</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:sequenceFlow id="b2" sourceRef="handle" targetRef="Eb"/>
      <bpmn:endEvent id="Eb"><bpmn:incoming>b2</bpmn:incoming></bpmn:endEvent>
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * M5-L3 Task 8 — completionCondition EARLY SETTLE over a serviceTask body:
 * parallel cardinality 4, task `probe`, completionCondition
 * `nrOfCompletedInstances >= 2`. Completing 2 of 4 iteration jobs settles the MI
 * `condition` decider once-only; the remaining 2 in-flight jobs are terminal-
 * abandoned as a NORMAL discard (never compensation). `results` collects the 2
 * finished outputs index-ordered, `null` at the abandoned indexes.
 */
export const MI_COND_BPMN = (taskType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_cond" targetNamespace="x">
  <bpmn:process id="P_mi_cond" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:serviceTask id="mi1" name="Probe each">
      <bpmn:extensionElements>
        <easy-bpmn:taskDefinition type="${taskType}" retries="1"/>
        <easy-bpmn:multiInstance outputVariable="results"/>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">4</bpmn:loopCardinality>
        <bpmn:completionCondition xsi:type="bpmn:tFormalExpression">nrOfCompletedInstances &gt;= 2</bpmn:completionCondition>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * M5-L3 Task 8 — completionCondition EARLY SETTLE over a SUBPROCESS body:
 * parallel cardinality 2, completionCondition `nrOfCompletedInstances >= 1`.
 * Completing iteration 0's interior `handle` job settles the decider at k=1; the
 * still-live `mi#1` iteration token is marked `discarded` (a NORMAL frontier
 * teardown, never compensation). Proves the token-discard cancel-remaining path.
 */
export const MI_COND_SUB_BPMN = (taskType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_cond_sub" targetNamespace="x">
  <bpmn:process id="P_mi_cond_sub" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:subProcess id="mi1" name="Probe each">
      <bpmn:extensionElements>
        <easy-bpmn:multiInstance outputVariable="results"/>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">2</bpmn:loopCardinality>
        <bpmn:completionCondition xsi:type="bpmn:tFormalExpression">nrOfCompletedInstances &gt;= 1</bpmn:completionCondition>
      </bpmn:multiInstanceLoopCharacteristics>
      <bpmn:startEvent id="Sb"><bpmn:outgoing>b1</bpmn:outgoing></bpmn:startEvent>
      <bpmn:sequenceFlow id="b1" sourceRef="Sb" targetRef="handle"/>
      <bpmn:serviceTask id="handle" name="Handle">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="${taskType}" retries="1"/></bpmn:extensionElements>
        <bpmn:incoming>b1</bpmn:incoming>
        <bpmn:outgoing>b2</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:sequenceFlow id="b2" sourceRef="handle" targetRef="Eb"/>
      <bpmn:endEvent id="Eb"><bpmn:incoming>b2</bpmn:incoming></bpmn:endEvent>
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * M5-L3 Task 8 — the FLAGSHIP non-compensating-discard gate: a SUBPROCESS MI
 * (cardinality 4, completionCondition `nrOfCompletedInstances >= 2`) inside a
 * transaction, with the interior `handle` task carrying a per-iteration
 * compensation boundary (→ `undoHandle`). After the MI early-settles at k=2 the
 * remaining iteration tokens are discarded; a subsequent `finalize` business
 * error routes through the error boundary to the transaction's cancel end, and
 * the reverse pass compensates EXACTLY the 2 finished iterations (occurrence-
 * keyed, reverse order) — the 2 discarded iterations ledger NOTHING.
 *
 * NB: the interior compensate boundary sits on `handle` (a plain serviceTask),
 * NOT on the MI activity `mi1` — a compensate-as-a-unit boundary on an MI
 * activity is a publish reject (design §4; validator un-defer is Task 11). The
 * subProcess-body per-iteration compensation rides the shipped occurrence-keyed
 * reverse pass with ZERO new compensation code (Task 7's strided interior
 * occurrences give each iteration a distinct `handle` occurrence).
 */
export const MI_COND_SUB_TX_BPMN = (handleType: string, undoType: string, finalizeType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_cond_tx" targetNamespace="x">
  <bpmn:error id="Err_finalize" name="Finalize failed" errorCode="FINALIZE_FAILED"/>
  <bpmn:process id="P_mi_cond_tx" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>g1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="g1" sourceRef="S" targetRef="Tx"/>
    <bpmn:transaction id="Tx" name="Reserve batch">
      <bpmn:startEvent id="Tx_start"><bpmn:outgoing>t1</bpmn:outgoing></bpmn:startEvent>
      <bpmn:sequenceFlow id="t1" sourceRef="Tx_start" targetRef="mi1"/>
      <bpmn:subProcess id="mi1" name="Reserve each">
        <bpmn:extensionElements>
          <easy-bpmn:multiInstance outputVariable="results"/>
        </bpmn:extensionElements>
        <bpmn:incoming>t1</bpmn:incoming>
        <bpmn:outgoing>t2</bpmn:outgoing>
        <bpmn:multiInstanceLoopCharacteristics isSequential="false">
          <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">4</bpmn:loopCardinality>
          <bpmn:completionCondition xsi:type="bpmn:tFormalExpression">nrOfCompletedInstances &gt;= 2</bpmn:completionCondition>
        </bpmn:multiInstanceLoopCharacteristics>
        <bpmn:startEvent id="Sb"><bpmn:outgoing>b1</bpmn:outgoing></bpmn:startEvent>
        <bpmn:sequenceFlow id="b1" sourceRef="Sb" targetRef="handle"/>
        <bpmn:serviceTask id="handle" name="Handle">
          <bpmn:extensionElements><easy-bpmn:taskDefinition type="${handleType}" retries="1"/></bpmn:extensionElements>
          <bpmn:incoming>b1</bpmn:incoming>
          <bpmn:outgoing>b2</bpmn:outgoing>
        </bpmn:serviceTask>
        <bpmn:boundaryEvent id="handle_comp" attachedToRef="handle">
          <bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
        <bpmn:serviceTask id="undoHandle" name="Undo handle" isForCompensation="true">
          <bpmn:extensionElements><easy-bpmn:taskDefinition type="${undoType}" retries="2"/></bpmn:extensionElements>
        </bpmn:serviceTask>
        <bpmn:association id="a1" associationDirection="One" sourceRef="handle_comp" targetRef="undoHandle"/>
        <bpmn:sequenceFlow id="b2" sourceRef="handle" targetRef="Eb"/>
        <bpmn:endEvent id="Eb"><bpmn:incoming>b2</bpmn:incoming></bpmn:endEvent>
      </bpmn:subProcess>
      <bpmn:sequenceFlow id="t2" sourceRef="mi1" targetRef="finalize"/>
      <bpmn:serviceTask id="finalize" name="Finalize">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="${finalizeType}" retries="1"/></bpmn:extensionElements>
        <bpmn:incoming>t2</bpmn:incoming>
        <bpmn:outgoing>t3</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:boundaryEvent id="finalize_err" attachedToRef="finalize">
        <bpmn:errorEventDefinition errorRef="Err_finalize"/></bpmn:boundaryEvent>
      <bpmn:endEvent id="Tx_ok"><bpmn:incoming>t3</bpmn:incoming></bpmn:endEvent>
      <bpmn:endEvent id="Tx_cancel"><bpmn:incoming>fe</bpmn:incoming><bpmn:cancelEventDefinition/></bpmn:endEvent>
      <bpmn:sequenceFlow id="t3" sourceRef="finalize" targetRef="Tx_ok"/>
      <bpmn:sequenceFlow id="fe" sourceRef="finalize_err" targetRef="Tx_cancel"/>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="Tx_cancelled" attachedToRef="Tx">
      <bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:endEvent id="Done"><bpmn:incoming>g2</bpmn:incoming></bpmn:endEvent>
    <bpmn:endEvent id="Failed"><bpmn:incoming>g3</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="Done"/>
    <bpmn:sequenceFlow id="g3" sourceRef="Tx_cancelled" targetRef="Failed"/>
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

/**
 * M5-L3 Task 9 — iteration BUSINESS error → MI abort → error boundary on the MI
 * activity. Parallel cardinality-3 serviceTask MI; an iteration failing with the
 * business code `MI_FAIL` aborts the whole visit (settle `abort`, drain the
 * in-flight iterations) and routes exactly as "the MI activity threw MI_FAIL":
 * the error boundary on `mi1` catches it → `handler` → `E2`.
 */
export const MI_ERR_BOUNDARY_BPMN = (taskType: string, handlerType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_err_boundary" targetNamespace="x">
  <bpmn:error id="Err_mi" name="MI failed" errorCode="MI_FAIL"/>
  <bpmn:process id="P_mi_err_boundary" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:serviceTask id="mi1" name="Charge each">
      <bpmn:extensionElements>
        <easy-bpmn:taskDefinition type="${taskType}" retries="1"/>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">3</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="mi1_err" attachedToRef="mi1"><bpmn:errorEventDefinition errorRef="Err_mi"/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="fe" sourceRef="mi1_err" targetRef="handler"/>
    <bpmn:serviceTask id="handler" name="Handle failure">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="${handlerType}" retries="1"/></bpmn:extensionElements>
      <bpmn:incoming>fe</bpmn:incoming>
      <bpmn:outgoing>fh</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="fh" sourceRef="handler" targetRef="E2"/>
    <bpmn:endEvent id="E2"><bpmn:incoming>fh</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * M5-L3 Task 9 — iteration BUSINESS error with NO matching boundary anywhere up
 * the scope chain → the MI aborts and settles a graceful `uncaughtError` incident
 * on the MI activity (mirrors the callActivity child-errored uncaught precedent).
 */
export const MI_ERR_UNCAUGHT_BPMN = (taskType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_err_uncaught" targetNamespace="x">
  <bpmn:process id="P_mi_err_uncaught" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:serviceTask id="mi1" name="Charge each">
      <bpmn:extensionElements>
        <easy-bpmn:taskDefinition type="${taskType}" retries="1"/>
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
 * M5-L3 Task 9 — a subProcess-body ERROR END routes identically to a worker
 * business error. Parallel cardinality-2 MI over a subProcess body
 * Sb → check → gw (XOR: `fail = true` → `Ebad` error-end MI_FAIL / default →
 * `Eok` none-end). An iteration whose `check` returns `fail: true` raises the
 * error end → the MI aborts + routes to the error boundary on `mi1` → `handler`.
 */
export const MI_ERR_SUB_BPMN = (checkType: string, handlerType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_err_sub" targetNamespace="x">
  <bpmn:error id="Err_mi" name="MI failed" errorCode="MI_FAIL"/>
  <bpmn:process id="P_mi_err_sub" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="mi1"/>
    <bpmn:subProcess id="mi1" name="Check each">
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">2</bpmn:loopCardinality>
      </bpmn:multiInstanceLoopCharacteristics>
      <bpmn:startEvent id="Sb"><bpmn:outgoing>b1</bpmn:outgoing></bpmn:startEvent>
      <bpmn:sequenceFlow id="b1" sourceRef="Sb" targetRef="check"/>
      <bpmn:serviceTask id="check" name="Check">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="${checkType}" retries="1"/></bpmn:extensionElements>
        <bpmn:incoming>b1</bpmn:incoming>
        <bpmn:outgoing>b2</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:sequenceFlow id="b2" sourceRef="check" targetRef="gw"/>
      <bpmn:exclusiveGateway id="gw" default="bOk">
        <bpmn:incoming>b2</bpmn:incoming>
        <bpmn:outgoing>bBad</bpmn:outgoing>
        <bpmn:outgoing>bOk</bpmn:outgoing>
      </bpmn:exclusiveGateway>
      <bpmn:sequenceFlow id="bBad" sourceRef="gw" targetRef="Ebad">
        <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">fail = true</bpmn:conditionExpression>
      </bpmn:sequenceFlow>
      <bpmn:sequenceFlow id="bOk" sourceRef="gw" targetRef="Eok"/>
      <bpmn:endEvent id="Ebad"><bpmn:incoming>bBad</bpmn:incoming><bpmn:errorEventDefinition errorRef="Err_mi"/></bpmn:endEvent>
      <bpmn:endEvent id="Eok"><bpmn:incoming>bOk</bpmn:incoming></bpmn:endEvent>
    </bpmn:subProcess>
    <bpmn:boundaryEvent id="mi1_err" attachedToRef="mi1"><bpmn:errorEventDefinition errorRef="Err_mi"/></bpmn:boundaryEvent>
    <bpmn:sequenceFlow id="fe" sourceRef="mi1_err" targetRef="handler"/>
    <bpmn:serviceTask id="handler" name="Handle">
      <bpmn:extensionElements><easy-bpmn:taskDefinition type="${handlerType}" retries="1"/></bpmn:extensionElements>
      <bpmn:incoming>fe</bpmn:incoming>
      <bpmn:outgoing>fh</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="fh" sourceRef="handler" targetRef="E2"/>
    <bpmn:endEvent id="E2"><bpmn:incoming>fh</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f2" sourceRef="mi1" targetRef="E"/>
    <bpmn:endEvent id="E"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/**
 * M5-L3 Task 9 — HAZARD timer on the MI activity (the L2 CALL_PARENT_TIMER shape,
 * now over a subProcess MI inside a transaction). A subProcess MI (cardinality 3,
 * interior `handle` with a per-iteration compensation boundary → `undoHandle`)
 * inside `Tx`, with a short timer boundary on the MI element → `onTimeout`. When
 * the timer fires while iterations are in flight it INTERRUPTS WITHOUT
 * COMPENSATION: the same retention drain (finished iterations' `pending` ledger
 * rows retained, in-flight abandoned), then the boundary flow — NO compensation
 * runs. A later operator `/cancel` compensates the retained finished iterations
 * (the M5-L1 §3.2 gate, now over MI rows).
 */
export const MI_TIMER_BPMN = (handleType: string, undoType: string, timeoutType: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
    xmlns:easy-bpmn="http://easy-bpmn/schema/1.0"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    id="D_mi_timer" targetNamespace="x">
  <bpmn:process id="P_mi_timer" isExecutable="true">
    <bpmn:startEvent id="S"><bpmn:outgoing>g1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="g1" sourceRef="S" targetRef="Tx"/>
    <bpmn:transaction id="Tx" name="Reserve batch">
      <bpmn:startEvent id="Tx_start"><bpmn:outgoing>t1</bpmn:outgoing></bpmn:startEvent>
      <bpmn:sequenceFlow id="t1" sourceRef="Tx_start" targetRef="mi1"/>
      <bpmn:subProcess id="mi1" name="Reserve each">
        <bpmn:incoming>t1</bpmn:incoming>
        <bpmn:outgoing>t2</bpmn:outgoing>
        <bpmn:multiInstanceLoopCharacteristics isSequential="false">
          <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression">3</bpmn:loopCardinality>
        </bpmn:multiInstanceLoopCharacteristics>
        <bpmn:startEvent id="Sb"><bpmn:outgoing>b1</bpmn:outgoing></bpmn:startEvent>
        <bpmn:sequenceFlow id="b1" sourceRef="Sb" targetRef="handle"/>
        <bpmn:serviceTask id="handle" name="Handle">
          <bpmn:extensionElements><easy-bpmn:taskDefinition type="${handleType}" retries="1"/></bpmn:extensionElements>
          <bpmn:incoming>b1</bpmn:incoming>
          <bpmn:outgoing>b2</bpmn:outgoing>
        </bpmn:serviceTask>
        <bpmn:boundaryEvent id="handle_comp" attachedToRef="handle">
          <bpmn:compensateEventDefinition/></bpmn:boundaryEvent>
        <bpmn:serviceTask id="undoHandle" name="Undo handle" isForCompensation="true">
          <bpmn:extensionElements><easy-bpmn:taskDefinition type="${undoType}" retries="2"/></bpmn:extensionElements>
        </bpmn:serviceTask>
        <bpmn:association id="a1" associationDirection="One" sourceRef="handle_comp" targetRef="undoHandle"/>
        <bpmn:sequenceFlow id="b2" sourceRef="handle" targetRef="Eb"/>
        <bpmn:endEvent id="Eb"><bpmn:incoming>b2</bpmn:incoming></bpmn:endEvent>
      </bpmn:subProcess>
      <bpmn:boundaryEvent id="mi1_timer" attachedToRef="mi1">
        <bpmn:timerEventDefinition><bpmn:timeDuration>PT30S</bpmn:timeDuration></bpmn:timerEventDefinition>
      </bpmn:boundaryEvent>
      <bpmn:sequenceFlow id="tf" sourceRef="mi1_timer" targetRef="onTimeout"/>
      <bpmn:serviceTask id="onTimeout" name="On timeout">
        <bpmn:extensionElements><easy-bpmn:taskDefinition type="${timeoutType}" retries="1"/></bpmn:extensionElements>
        <bpmn:incoming>tf</bpmn:incoming>
        <bpmn:outgoing>tt</bpmn:outgoing>
      </bpmn:serviceTask>
      <bpmn:sequenceFlow id="tt" sourceRef="onTimeout" targetRef="Tx_ok"/>
      <bpmn:sequenceFlow id="t2" sourceRef="mi1" targetRef="Tx_ok"/>
      <bpmn:endEvent id="Tx_ok"><bpmn:incoming>t2</bpmn:incoming><bpmn:incoming>tt</bpmn:incoming></bpmn:endEvent>
    </bpmn:transaction>
    <bpmn:boundaryEvent id="Tx_cancelled" attachedToRef="Tx">
      <bpmn:cancelEventDefinition/></bpmn:boundaryEvent>
    <bpmn:endEvent id="Done"><bpmn:incoming>g2</bpmn:incoming></bpmn:endEvent>
    <bpmn:endEvent id="Failed"><bpmn:incoming>g3</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="g2" sourceRef="Tx" targetRef="Done"/>
    <bpmn:sequenceFlow id="g3" sourceRef="Tx_cancelled" targetRef="Failed"/>
  </bpmn:process>
</bpmn:definitions>`;
