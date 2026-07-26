// Welcome to VisualMyAlgo!
// Paste your code below and add visualization tracers to step through execution.

// import visualization libraries {
const { Array1DTracer, Array2DTracer, Layout, LogTracer, Tracer, VerticalLayout } = require('algorithm-visualizer');
// }

// define tracer variables {
const tracer = new Array1DTracer('Visual My Algo - Array Tracer');
const logger = new LogTracer('Execution Log');
// }

// define input variables
const DUMMY_ARRAY = [14, 8, 22, 5, 31, 19, 12, 42];

(function main() {
  // visualize {
  Layout.setRoot(new VerticalLayout([tracer, logger]));
  tracer.set(DUMMY_ARRAY);
  logger.println('Starting Bubble Sort visualization...');
  Tracer.delay();
  // }

  const N = DUMMY_ARRAY.length;
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < N - i - 1; j++) {
      // visualize {
      tracer.select(j, j + 1);
      Tracer.delay();
      // }

      if (DUMMY_ARRAY[j] > DUMMY_ARRAY[j + 1]) {
        const temp = DUMMY_ARRAY[j];
        DUMMY_ARRAY[j] = DUMMY_ARRAY[j + 1];
        DUMMY_ARRAY[j + 1] = temp;

        // visualize {
        tracer.patch(j, DUMMY_ARRAY[j]);
        tracer.patch(j + 1, DUMMY_ARRAY[j + 1]);
        logger.println(`Swapped ${DUMMY_ARRAY[j + 1]} and ${DUMMY_ARRAY[j]}`);
        Tracer.delay();
        tracer.depatch(j);
        tracer.depatch(j + 1);
        // }
      }

      // visualize {
      tracer.deselect(j, j + 1);
      // }
    }
  }

  // visualize {
  logger.println('Algorithm execution completed successfully!');
  // }
})();

