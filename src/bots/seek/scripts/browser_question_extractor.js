// Browser-side JavaScript for extracting employer questions from job application pages
// This script runs inside the browser context via Selenium's executeScript

function extractEmployerQuestions() {
  var questions = [];
  var questionCounter = 0;

  // Strategy 1: Seek-specific - find questions by looking for specific patterns
  // Look for containers that have labels with 'for' attributes pointing to form elements
  var allLabels = document.querySelectorAll('label[for]');
  var processedQuestions = new Set();

  allLabels.forEach(function(label) {
    const forId = label.getAttribute('for');
    const formElement = document.getElementById(forId);

    if (!formElement) return;

    // Handle checkbox groups using the label-driven approach

    // Get question text from the label
    const strongEl = label.querySelector('strong');
    let questionText = strongEl ? strongEl.textContent.trim() : label.textContent.trim();

    if (!questionText || processedQuestions.has(questionText)) return;
    processedQuestions.add(questionText);

    // Find the container (usually several divs up from the form element)
    let container = formElement.closest('div[class*="_5wkk7p0"]');
    if (!container) container = formElement.parentElement;

    // Assign unique ID to container for reliable selection
    const uniqueId = `gemini-q-seek-${questionCounter++}`;
    container.id = uniqueId;
    const containerSelector = `#${uniqueId}`;

    // Debug: Log what we found
    console.log(`Found form element for "${questionText}": tagName=${formElement.tagName}, type=${formElement.type}, id=${forId}`);

    // Determine question type based on the form element
    if (formElement.tagName === 'SELECT') {
      console.log(`SELECT element has ${formElement.options.length} options`);

      const rawOptions = Array.from(formElement.options);
      rawOptions.forEach((opt, i) => {
        console.log(`Option ${i}: textContent="${opt.textContent}", innerText="${opt.innerText}", value="${opt.value}"`);
      });

      const options = rawOptions
        .map(opt => {
          const text = opt.textContent || opt.innerText || opt.text || '';
          return text.trim();
        })
        .filter(opt => opt && opt !== '' && opt !== 'Select...' && opt !== 'Please select' && opt !== 'Choose...'); // Filter out empty and placeholder options

      console.log(`SELECT final options for "${questionText}":`, options);

      questions.push({
        type: 'select',
        question: questionText,
        options: options,
        containerSelector: containerSelector,
        elementId: forId
      });
    } else if (formElement.tagName === 'TEXTAREA' || formElement.type === 'text') {
      questions.push({
        type: 'text',
        question: questionText,
        options: [],
        containerSelector: containerSelector,
        elementId: forId
      });
    } else if (formElement.type === 'radio') {
      // For radio buttons, find all with the same name
      const radioGroup = document.querySelectorAll(`input[type="radio"][name="${formElement.name}"]`);
      const options = Array.from(radioGroup).map(radio => {
        const radioLabel = document.querySelector(`label[for="${radio.id}"]`);
        return radioLabel ? radioLabel.textContent.trim() : radio.value;
      }).filter(opt => opt);

      questions.push({
        type: 'radio',
        question: questionText,
        options: options,
        containerSelector: containerSelector,
        elementId: forId,
        radioName: formElement.name
      });
    } else if (formElement.type === 'checkbox') {
      // For checkboxes, group by name to handle multi-select questions
      const checkboxName = formElement.name;
      const existingQuestion = questions.find(q => q.checkboxName === checkboxName);

      if (existingQuestion) {
        // Add option to existing multi-checkbox question
        existingQuestion.options.push(questionText);
        existingQuestion.checkboxIds.push(forId);
      } else {
        // Find the main question text by traversing up the DOM tree
        let mainQuestionText = questionText;
        let currentElement = container;

        // Look for the main question in parent elements (up to 5 levels)
        for (let i = 0; i < 5; i++) {
          if (!currentElement || !currentElement.parentElement) break;
          currentElement = currentElement.parentElement;

          // Look for strong text that's different from the option text
          const strongElements = currentElement.querySelectorAll('strong');
          for (const strongEl of strongElements) {
            const strongText = strongEl.textContent.trim();
            // Check if this looks like a main question (longer than option text and contains question words)
            if (strongText.length > questionText.length &&
                strongText !== questionText &&
                (strongText.includes('?') || strongText.includes('following') || strongText.includes('which'))) {
              mainQuestionText = strongText;
              break;
            }
          }
          if (mainQuestionText !== questionText) break;
        }

        // Assign unique ID to the main question container for targeting
        const mainQuestionId = `checkbox-group-${questionCounter++}`;
        if (currentElement) {
          currentElement.id = mainQuestionId;
        }

        questions.push({
          type: 'checkbox',
          question: mainQuestionText,
          options: [questionText],
          containerSelector: `#${mainQuestionId}`,
          elementId: forId,
          checkboxName: checkboxName,
          checkboxIds: [forId]
        });
      }
    }
  });

  // Handle checkbox groups separately
  const checkboxGroups = {};
  const allCheckboxes = document.querySelectorAll('input[type="checkbox"]');

  allCheckboxes.forEach(function(checkbox) {
    const name = checkbox.name;
    if (!name) return;

    if (!checkboxGroups[name]) {
      checkboxGroups[name] = {
        checkboxes: [],
        options: []
      };
    }

    // Find the label for this checkbox
    const label = document.querySelector(`label[for="${checkbox.id}"]`);
    const optionText = label ? label.textContent.trim() : '';

    checkboxGroups[name].checkboxes.push(checkbox);
    checkboxGroups[name].options.push(optionText);
  });

  // Convert checkbox groups to questions
  Object.keys(checkboxGroups).forEach(function(name) {
    const group = checkboxGroups[name];
    if (group.checkboxes.length === 0) return;

    // Find the main question text by looking for strong elements near the first checkbox
    let mainQuestion = '';
    let currentElement = group.checkboxes[0];

    // Look up the DOM tree for the main question
    for (let i = 0; i < 10; i++) {
      currentElement = currentElement.parentElement;
      if (!currentElement) break;

      const strongEl = currentElement.querySelector('strong');
      if (strongEl) {
        const text = strongEl.textContent.trim();
        if (text.length > mainQuestion.length && (text.includes('?') || text.includes('following'))) {
          mainQuestion = text;
        }
      }
    }

    if (mainQuestion && !processedQuestions.has(mainQuestion)) {
      processedQuestions.add(mainQuestion);

      // Create container ID for the checkbox group
      const containerId = `checkbox-group-${questionCounter++}`;
      const firstCheckbox = group.checkboxes[0];
      let container = firstCheckbox.closest('div[class*="_5wkk7p0"]');
      if (container) {
        container.id = containerId;
      }

      console.log(`Found checkbox group "${mainQuestion}" with ${group.options.length} options:`, group.options);

      questions.push({
        type: 'checkbox',
        question: mainQuestion,
        options: group.options,
        containerSelector: `#${containerId}`,
        elementId: firstCheckbox.id,
        checkboxName: name,
        checkboxIds: group.checkboxes.map(cb => cb.id)
      });
    }
  });

  // Strategy 2: Additional fallback - find SELECT elements that might have been missed
  const allSelects = document.querySelectorAll('select');
  allSelects.forEach(function(selectElement) {
    const selectId = selectElement.id;

    // Skip if we already processed this select
    if (questions.some(q => q.elementId === selectId)) return;

    // Try to find the question text
    const label = document.querySelector(`label[for="${selectId}"]`);
    let questionText = '';

    if (label) {
      const strongEl = label.querySelector('strong');
      questionText = strongEl ? strongEl.textContent.trim() : label.textContent.trim();
    } else {
      // Look for nearby text that might be the question
      let parent = selectElement.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        const strongEl = parent.querySelector('strong');
        if (strongEl) {
          questionText = strongEl.textContent.trim();
          break;
        }
        parent = parent.parentElement;
      }
    }

    if (questionText && !processedQuestions.has(questionText)) {
      processedQuestions.add(questionText);

      const rawOptions = Array.from(selectElement.options);
      const options = rawOptions
        .map(opt => {
          const text = opt.textContent || opt.innerText || opt.text || '';
          return text.trim();
        })
        .filter(opt => opt && opt !== '' && opt !== 'Select...' && opt !== 'Please select' && opt !== 'Choose...');

      // Create container
      const uniqueId = `gemini-q-seek-fallback-${questionCounter++}`;
      let container = selectElement.closest('div[class*="_5wkk7p0"]') || selectElement.parentElement;
      if (container) {
        container.id = uniqueId;
      }

      console.log(`Fallback SELECT found: "${questionText}" with ${options.length} options:`, options);

      questions.push({
        type: 'select',
        question: questionText,
        options: options,
        containerSelector: `#${uniqueId}`,
        elementId: selectId || uniqueId
      });
    }
  });

  // Debug: Log extracted questions
  console.log('Seek extraction found', questions.length, 'questions:');
  questions.forEach(function(q, i) {
    console.log(`  ${i + 1}. ${q.question} (${q.type})`);
    if (q.options && q.options.length > 0) {
      console.log(`     Options: ${q.options.join(', ')}`);
    }
  });

  return {
    questionsFound: questions.length,
    questions: questions,
  };
}

return extractEmployerQuestions();
