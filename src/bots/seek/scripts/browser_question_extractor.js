// Browser-side JavaScript for extracting employer questions from job application pages
// This script runs inside the browser context via Selenium's executeScript

function extractEmployerQuestions() {
  var questions = [];
  var questionCounter = 0;

  // Helper: find the real group/question label for a radio or checkbox element
  function findGroupLabel(element, optionTexts) {
    // Priority 1: fieldset > legend
    var fieldset = element.closest('fieldset');
    if (fieldset) {
      var legend = fieldset.querySelector('legend');
      if (legend && legend.textContent.trim()) return legend.textContent.trim();
    }
    // Priority 2: [role="group"] aria-label / aria-labelledby
    var group = element.closest('[role="group"]');
    if (group) {
      var ariaLabel = group.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();
      var labelledBy = group.getAttribute('aria-labelledby');
      if (labelledBy) {
        var el = document.getElementById(labelledBy);
        if (el) return el.textContent.trim();
      }
    }
    // Priority 3: walk up the DOM looking for a <strong> that is not an option
    var current = element.parentElement;
    for (var i = 0; i < 8 && current; i++) {
      var strongs = current.querySelectorAll('strong');
      for (var s = 0; s < strongs.length; s++) {
        var text = strongs[s].textContent.trim();
        if (text && optionTexts.indexOf(text) === -1 &&
            (text.includes('?') || text.toLowerCase().includes('following') ||
             text.toLowerCase().includes('which') || text.toLowerCase().includes('experience') ||
             text.toLowerCase().includes('how many') || text.toLowerCase().includes('describe'))) {
          return text;
        }
      }
      current = current.parentElement;
    }
    return '';
  }

  // Strategy 1: Seek-specific - find questions by looking for specific patterns
  // Look for containers that have labels with 'for' attributes pointing to form elements
  var allLabels = document.querySelectorAll('label[for]');
  var processedQuestions = new Set();
  var processedRadioNames = new Set();

  allLabels.forEach(function(label) {
    const forId = label.getAttribute('for');
    const formElement = document.getElementById(forId);

    if (!formElement) return;

    // Get question text from the label
    const strongEl = label.querySelector('strong');
    let questionText = strongEl ? strongEl.textContent.trim() : label.textContent.trim();

    if (!questionText) return;

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
      if (processedQuestions.has(questionText)) return;
      processedQuestions.add(questionText);

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
      if (processedQuestions.has(questionText)) return;
      processedQuestions.add(questionText);

      questions.push({
        type: 'text',
        question: questionText,
        options: [],
        containerSelector: containerSelector,
        elementId: forId
      });
    } else if (formElement.type === 'radio') {
      var radioName = formElement.name;
      // Skip — this radio group was already added via a previous label
      if (processedRadioNames.has(radioName)) return;
      processedRadioNames.add(radioName);

      var radioGroup = document.querySelectorAll('input[type="radio"][name="' + radioName + '"]');
      var options = Array.from(radioGroup).map(function(radio) {
        var radioLabel = document.querySelector('label[for="' + radio.id + '"]');
        return radioLabel ? radioLabel.textContent.trim() : radio.value;
      }).filter(function(opt) { return opt; });

      // Find the real question heading — NOT the option label text
      var realQuestion = findGroupLabel(formElement, options);
      if (!realQuestion) {
        // Last resort: use questionText only if it doesn't look like an option
        realQuestion = options.indexOf(questionText) === -1 ? questionText : '';
      }
      if (!realQuestion) return; // Can't determine question text — skip

      // Track by real question text to avoid duplicates
      if (processedQuestions.has(realQuestion)) return;
      processedQuestions.add(realQuestion);

      questions.push({
        type: 'radio',
        question: realQuestion,
        options: options,
        containerSelector: containerSelector,
        elementId: forId,
        radioName: radioName
      });
    } else if (formElement.type === 'checkbox') {
      // Handled by the checkbox-group pass below — skip here to avoid duplicates
      return;
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

    // Find the main question text using the group label helper
    var mainQuestion = findGroupLabel(group.checkboxes[0], group.options);

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
