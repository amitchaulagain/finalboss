import type { WorkflowContext } from '../../core/workflow_engine';
import { isGenericQuestion, getGenericAnswer } from './generic_question_handler';
import { getIntelligentAnswers, extractQuestionsFromPage } from './intelligent_qa_handler';
import { getJobArtifactDir } from '../../core/client_paths';

const printLog = (message: string) => {
  console.log(message);
};

export type FillFailureReason =
  | 'none'
  | 'missing_container_selector'
  | 'container_not_found'
  | 'option_not_found'
  | 'element_not_found'
  | 'element_not_interactable'
  | 'unsupported_question_type'
  | 'script_error'
  | 'unknown_error';

export interface FillQuestionResult {
  success: boolean;
  failureReason: FillFailureReason;
  error?: string;
}

function mapFailureReason(questionType: string, errorText?: string): FillFailureReason {
  const msg = (errorText || '').toLowerCase();
  if (!msg) return 'unknown_error';
  if (msg.includes('containerselector is missing')) return 'missing_container_selector';
  if (msg.includes('container not found')) return 'container_not_found';
  if (msg.includes('option not found') || msg.includes('requested index')) return 'option_not_found';
  if (msg.includes('no such element') || msg.includes('not found')) return 'element_not_found';
  if (msg.includes('not interactable') || msg.includes('element click intercepted') || msg.includes('stale element')) {
    return 'element_not_interactable';
  }
  if (msg.includes('unknown question type')) return 'unsupported_question_type';
  if (msg.includes('javascript error') || msg.includes('execute script')) return 'script_error';
  if ((questionType === 'select' || questionType === 'radio') && msg.includes('index')) return 'option_not_found';
  return 'unknown_error';
}

// Refactored to use the robust containerSelector from the extraction step
// When modalScopeSelector is set (e.g. LinkedIn Easy Apply), we find the container inside that modal so we don't match elements outside it
export async function fillQuestionFieldDetailed(
  ctx: WorkflowContext,
  containerSelector: string, // The robust selector for the question's container
  questionType: string,
  answer: any,
  modalScopeSelector?: string, // Optional: scope to this modal (e.g. "[data-test-modal-id='easy-apply-modal']")
  radioName?: string // Optional: name attribute for radio group filtering
): Promise<FillQuestionResult> {
  if (!containerSelector) {
    printLog('❌ Cannot fill field: containerSelector is missing.');
    return { success: false, failureReason: 'missing_container_selector', error: 'containerSelector is missing' };
  }

  const answerIdx = modalScopeSelector ? 2 : 1;
  const getContainerScript = modalScopeSelector
    ? 'var modal = document.querySelector(arguments[0]); var container = modal ? modal.querySelector(arguments[1]) : null;'
    : 'var container = document.querySelector(arguments[0]);';
  const selectArgs = modalScopeSelector ? [modalScopeSelector, containerSelector, answer] : [containerSelector, answer];
  const radioArgs = modalScopeSelector
    ? [modalScopeSelector, containerSelector, answer, radioName || '']
    : [containerSelector, answer, radioName || ''];
  const checkboxArgs = modalScopeSelector ? [modalScopeSelector, containerSelector, Array.isArray(answer) ? answer : [answer]] : [containerSelector, Array.isArray(answer) ? answer : [answer]];

  try {
    switch (questionType) {
      case 'select':
        const selectResult = await ctx.driver.executeScript(`
          ${getContainerScript}
          if (!container) return { success: false, error: 'Container not found' };

          // Debug: what's actually in the container
          console.log('Container HTML:', container.outerHTML);
          console.log('Container tagName:', container.tagName);

          // Try multiple ways to find the select element
          let select = container.querySelector('select');
          if (!select && container.tagName === 'SELECT') {
            select = container; // The container itself is the select
          }
          if (!select) {
            // Also check if there's a select as a direct child or sibling
            select = container.parentElement?.querySelector('select');
          }

          const answerIndex = arguments[${answerIdx}];

          if (select && select.options && select.options[answerIndex]) {
            select.selectedIndex = answerIndex;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true };
          }
          return {
            success: false,
            error: 'Select element or option not found. Found select: ' + !!select +
                   ', container tagName: ' + container.tagName +
                   ', has options: ' + (select ? select.options.length : 0) +
                   ', container id: ' + container.id
          };
        `, ...selectArgs);

        if (!selectResult.success) {
          printLog(`Failed to fill select: ${selectResult.error}`);
          return {
            success: false,
            failureReason: mapFailureReason(questionType, String(selectResult.error || '')),
            error: String(selectResult.error || '')
          };
        }
        return { success: true, failureReason: 'none' };

      case 'radio':
        const radioNameIdx = modalScopeSelector ? 3 : 2;
        // Step 1: Find the target radio button and return its ID for Selenium click
        const radioData = await ctx.driver.executeScript(`
          ${getContainerScript}
          if (!container) return { success: false, error: 'Container not found' };

          var radioNameFilter = arguments[${radioNameIdx}];
          var selector = radioNameFilter
            ? 'input[type="radio"][name="' + radioNameFilter + '"]'
            : 'input[type="radio"]';
          var radioButtons = container.querySelectorAll(selector);
          var answerIndex = arguments[${answerIdx}];

          if (radioButtons && radioButtons[answerIndex]) {
            var target = radioButtons[answerIndex];
            // Ensure it has an ID for Selenium to find it
            if (!target.id) {
              target.id = 'seek-radio-fill-' + Date.now() + '-' + answerIndex;
            }
            return { success: true, radioId: target.id, totalRadios: radioButtons.length };
          }
          return { success: false, error: 'Radio button not found. Found radios: ' + radioButtons.length + ', requested index: ' + answerIndex + ', nameFilter: ' + (radioNameFilter || 'none') };
        `, ...radioArgs);

        if (!radioData.success) {
          printLog(`Failed to find radio: ${radioData.error}`);
          return {
            success: false,
            failureReason: mapFailureReason(questionType, String(radioData.error || '')),
            error: String(radioData.error || '')
          };
        }

        // Step 2: Click the radio button using Selenium (fires all native events)
        try {
          const radioElement = await ctx.driver.findElement({ css: `input[id="${radioData.radioId}"]` });
          await radioElement.click();
          printLog(`✅ Clicked radio button (ID: ${radioData.radioId})`);
        } catch (clickError) {
          printLog(`❌ Failed to click radio button: ${clickError}`);
          return {
            success: false,
            failureReason: mapFailureReason(questionType, String(clickError)),
            error: String(clickError)
          };
        }

        // Step 3: Verify the radio button is checked
        const radioVerify = await ctx.driver.executeScript(`
          var radio = document.getElementById(arguments[0]);
          return radio ? { checked: radio.checked } : { checked: false };
        `, radioData.radioId);

        if (!radioVerify.checked) {
          printLog(`⚠️ Radio button verification failed - not checked after click`);
          return {
            success: false,
            failureReason: 'element_not_interactable',
            error: 'Radio button was not checked after clicking'
          };
        }

        printLog(`✅ Radio button verified as checked`);
        return { success: true, failureReason: 'none' };

      case 'text':
      case 'textarea':
        try {
          const textScriptArgs = modalScopeSelector ? [modalScopeSelector, containerSelector] : [containerSelector];
          const textElements = await ctx.driver.executeScript(`
            ${getContainerScript}
            if (!container) return null;

            const textElement = container.querySelector('textarea, input[type="text"]');
            if (textElement) {
              return {
                tagName: textElement.tagName.toLowerCase(),
                selector: textElement.tagName.toLowerCase() +
                         (textElement.id ? '#' + textElement.id : '') +
                         (textElement.className ? '.' + textElement.className.split(' ').filter(Boolean).join('.') : '')
              };
            }
            return null;
          `, ...textScriptArgs);

          if (!textElements) {
            printLog(`Failed to find text element in container: ${containerSelector}`);
            return { success: false, failureReason: 'element_not_found', error: 'Text element not found in container' };
          }

          const fullSelector = modalScopeSelector
            ? `${modalScopeSelector} ${containerSelector} ${textElements.tagName}`
            : `${containerSelector} ${textElements.tagName}`;
          printLog(`Found text element: ${fullSelector}`);

          const textElement = await ctx.driver.findElement({ css: fullSelector });

          // Clear existing content first
          await textElement.clear();

          // Use sendKeys to simulate human typing (triggers proper events)
          await textElement.sendKeys(answer.toString());

          // Wait for form processing
          await ctx.driver.sleep(500);

          printLog(`✅ Successfully filled text field with: "${answer}"`);
          return { success: true, failureReason: 'none' };

        } catch (error) {
          printLog(`❌ Failed to fill text field: ${error}`);
          return {
            success: false,
            failureReason: mapFailureReason(questionType, String(error)),
            error: String(error)
          };
        }

      case 'checkbox':
        try {
          const checkboxAnswers = Array.isArray(answer) ? answer : [answer];
          printLog(`[DEBUG] Checkbox - attempting to select: ${checkboxAnswers.join(', ')}`);

          const checkboxData = await ctx.driver.executeScript(`
            ${getContainerScript}
            if (!container) {
              return { success: false, error: 'Container not found' };
            }

            const checkboxes = container.querySelectorAll('input[type="checkbox"]');
            if (checkboxes.length === 0) {
              return { success: false, error: 'No checkboxes found' };
            }

            const answersToSelect = arguments[${answerIdx}];
            const checkboxesToClick = [];

            for (const answerText of answersToSelect) {
              for (const checkbox of checkboxes) {
                const label = document.querySelector('label[for="' + checkbox.id + '"]');
                const optionText = label ? label.textContent.trim() : '';

                if (optionText.toLowerCase() === answerText.toLowerCase()) {
                  checkboxesToClick.push({
                    id: checkbox.id,
                    optionText: optionText,
                    checked: checkbox.checked
                  });
                  break;
                }
              }
            }

            return {
              success: true,
              checkboxesToClick: checkboxesToClick
            };
          `, ...checkboxArgs);

          if (!checkboxData.success) {
            printLog(`❌ Failed to find checkboxes: ${checkboxData.error}`);
            return {
              success: false,
              failureReason: mapFailureReason(questionType, String(checkboxData.error || '')),
              error: String(checkboxData.error || '')
            };
          }

          // Click each checkbox using Selenium WebDriver
          let successCount = 0;
          for (const checkboxInfo of checkboxData.checkboxesToClick) {
            try {
              printLog(`[DEBUG] Clicking checkbox for "${checkboxInfo.optionText}" (ID: ${checkboxInfo.id})`);

              // Find the checkbox element using Selenium
              const checkboxElement = await ctx.driver.findElement({ css: `input[id="${checkboxInfo.id}"]` });

              // Click it using Selenium (this should properly trigger React/framework events)
              await checkboxElement.click();

              successCount++;
              printLog(`✅ Successfully clicked checkbox for "${checkboxInfo.optionText}"`);

              // Small delay between clicks
              await ctx.driver.sleep(100);
            } catch (error) {
              printLog(`❌ Failed to click checkbox for "${checkboxInfo.optionText}": ${error}`);
            }
          }

          // Verify final state
          const finalState = await ctx.driver.executeScript(`
            ${getContainerScript}
            const checkboxes = container ? container.querySelectorAll('input[type="checkbox"]') : [];
            const state = [];
            for (const checkbox of checkboxes) {
              const label = document.querySelector('label[for="' + checkbox.id + '"]');
              state.push({
                option: label ? label.textContent.trim() : 'N/A',
                checked: checkbox.checked
              });
            }
            return state;
          `, ...(modalScopeSelector ? [modalScopeSelector, containerSelector] : [containerSelector]));

          console.log('[DEBUG] Final checkbox state:', JSON.stringify(finalState, null, 2));

          if (successCount > 0) {
            printLog(`✅ Successfully clicked ${successCount} checkboxes using Selenium`);
            return { success: true, failureReason: 'none' };
          } else {
            printLog(`❌ Failed to click any checkboxes`);
            return { success: false, failureReason: 'element_not_interactable', error: 'Failed to click any checkboxes' };
          }
        } catch (error) {
          printLog(`❌ CRASH in checkbox field logic: ${error}`);
          return {
            success: false,
            failureReason: mapFailureReason(questionType, String(error)),
            error: String(error)
          };
        }

      default:
        printLog(`⚠️ Unknown question type: ${questionType}`);
        return { success: false, failureReason: 'unsupported_question_type', error: `Unknown question type: ${questionType}` };
    }
  } catch (error) {
    printLog(`❌ Failed to fill question field: ${error}`);
    return {
      success: false,
      failureReason: mapFailureReason(questionType, String(error)),
      error: String(error)
    };
  }
}

export async function fillQuestionField(
  ctx: WorkflowContext,
  containerSelector: string,
  questionType: string,
  answer: any,
  modalScopeSelector?: string,
  radioName?: string
): Promise<boolean> {
  const result = await fillQuestionFieldDetailed(ctx, containerSelector, questionType, answer, modalScopeSelector, radioName);
  return result.success;
}

// Enhanced handler that uses unified intelligent Q&A approach
export async function* answerEmployerQuestions(ctx: WorkflowContext): AsyncGenerator<string, void, unknown> {
  try {
    printLog("🔍 Starting intelligent employer questions handling...");

    const questions = await extractQuestionsFromPage(ctx);

    if (questions.length === 0) {
      printLog("ℹ️ No questions found on current page");
      yield "no_questions";
      return;
    }

    printLog(`📋 Found ${questions.length} employer questions to answer`);

    const answeredQuestions = await getIntelligentAnswers(questions, ctx);

    printLog("\n📋 Question answering plan:");
    answeredQuestions.forEach((q: any, index: number) => {
      printLog(`   ${index + 1}. [${q.answerSource}] ${q.question}`);
    });

    let successCount = 0;
    let errorCount = 0;
    const qnaResults: any[] = [];

    for (let i = 0; i < answeredQuestions.length; i++) {
      const question = answeredQuestions[i];
      try {
        printLog(`[DEBUG] Processing question ${i + 1}: ${JSON.stringify(question, null, 2)}`);
        printLog(`🎯 Filling Q${i + 1} [${question.answerSource}]: "${question.question}"`);

        let answer;
        if (question.type === 'select' || question.type === 'radio') {
          answer = question.selectedAnswer;
        } else if (question.type === 'text') {
          answer = question.textAnswer;
        } else if (question.type === 'checkbox') {
          if (question.selectedAnswer && Array.isArray(question.selectedAnswer)) {
            // Check if selectedAnswer contains strings (option text) or numbers (indices)
            if (typeof question.selectedAnswer[0] === 'string') {
              // selectedAnswer contains option text
              answer = question.selectedAnswer;
              printLog(`📝 Using generic checkbox answers (text): ${answer.join(', ')}`);
            } else {
              // selectedAnswer contains indices - convert to option text
              const options = question.options || [];
              answer = question.selectedAnswer.map((index: number) => options[index]).filter(Boolean);
              printLog(`📝 Using generic checkbox answers (indices ${question.selectedAnswer}): ${answer.join(', ')}`);
            }
          } else {
            const options = question.opts || [];
            if (options.length > 0) {
              // Fallback: Select 2 random options, or fewer if not enough are available
              const numToSelect = Math.min(2, options.length);
              const shuffled = options.sort(() => 0.5 - Math.random());
              answer = shuffled.slice(0, numToSelect);
              printLog(`📝 Randomly selected checkbox answers: ${answer.join(', ')}`);
            }
          }
        }

        if (answer !== undefined && answer !== null && question.answerSource !== 'No Answer') {
          const filled = await fillQuestionField(ctx, question.containerSelector, question.type, answer, undefined, question.radioName);
          const options = question.options || question.opts || [];
          const selected =
            question.type === 'select' || question.type === 'radio'
              ? (typeof answer === 'number' ? answer : null)
              : question.type === 'checkbox'
                ? (Array.isArray(answer) ? answer : [answer])
                : null;
          const resolvedAnswer =
            typeof answer === 'number' && Array.isArray(options) && options[answer] != null
              ? String(options[answer])
              : Array.isArray(answer)
                ? answer.map((x: unknown) => String(x)).join(', ')
                : String(answer);

          if (filled) {
            printLog(`✅ Question ${i + 1} answered successfully`);
            successCount++;
            qnaResults.push({
              question: question.question,
              type: question.type,
              options,
              selected,
              answer: resolvedAnswer,
              answerSource: question.answerSource,
              status: 'success'
            });
          } else {
            printLog(`⚠️ Failed to fill form field for question ${i + 1}`);
            errorCount++;
            qnaResults.push({
              question: question.question,
              type: question.type,
              options,
              selected,
              answer: resolvedAnswer,
              answerSource: question.answerSource,
              status: 'failed'
            });
          }
        } else {
          printLog(`⏭️ Skipping question ${i + 1} - no answer available`);
          qnaResults.push({
            question: question.question,
            type: question.type,
            answer: null,
            answerSource: 'No Answer',
            status: 'skipped'
          });
        }

        await ctx.driver.sleep(500);
      } catch (error) {
        printLog(`❌ Error answering question ${i + 1}: ${error}`);
        errorCount++;
        qnaResults.push({
          question: question.question,
          type: question.type,
          error: String(error),
          status: 'error'
        });
      }
    }

    const fs = await import('fs');
    const path = await import('path');
    let jobData: any = {};
    if (ctx.currentJobFile) {
      jobData = JSON.parse(fs.readFileSync(ctx.currentJobFile, 'utf8'));
    }
    const jobId = jobData.jobId || 'unknown';
    const jobDir = getJobArtifactDir(ctx, 'seek', jobId);
    fs.writeFileSync(
      path.join(jobDir, 'qna.json'),
      JSON.stringify({ questions: qnaResults, summary: { total: answeredQuestions.length, success: successCount, errors: errorCount } }, null, 2)
    );
    printLog(`💾 QNA saved to qna.json`);

    printLog(`📊 Results: ${successCount}/${answeredQuestions.length} questions answered, ${errorCount} errors`);

    if (errorCount === 0 && answeredQuestions.length > 0) {
      yield "employer_questions_saved";
    } else if (answeredQuestions.length === 0) {
      yield "no_questions";
    } else {
      yield "employer_questions_error";
    }

  } catch (error) {
    printLog(`💥 Intelligent employer questions handler crash: ${error}`);
    yield "employer_questions_error";
  }
}
