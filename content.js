// Flex 근무시간 합산 익스텐션
(function() {
  'use strict';

  // ============================================================
  // CONFIGURATION LAYER - 중앙 집중식 설정
  // ============================================================
  const CONFIG = {
    WORK_SCHEDULE: {
      LUNCH_BREAK_MINUTES: 60,        // 점심시간 (분)
      WEEKLY_TARGET_HOURS: 40,        // 주간 목표 근무시간
      DAILY_WORK_HOURS: 8,            // 일일 기본 근무시간
      REGULAR_WORK_DAYS: [1, 2, 3, 4], // 월~목
      FLEX_DAY: 5,                    // 금요일
      WEEKEND_DAYS: [0, 6]            // 일, 토
    },

    TIMING: {
      RETRY_INTERVAL: 500,            // 재시도 간격 (ms)
      MAX_RETRIES: 20,                // 최대 재시도 횟수
      OBSERVER_TIMEOUT: 10000,        // MutationObserver 타임아웃
      INITIAL_DELAY: 1000             // 초기 지연 시간
    },

    DOM_SELECTORS: {
      TIME_ELEMENT: 'button[class*="time"] time, time',
      RECORDING_TEXT: '기록 중',
      BREAK_BUTTON_TEXT: '휴게',
      CONTAINER_SELECTORS: 'section, div[class*="container"]'
    },

    UI: {
      DISPLAY_ID: 'flex-total-time-display',
      ERROR_DISPLAY_ID: 'flex-error-display',
      ANIMATION_DURATION: 300
    },

    VALIDATION: {
      MAX_REASONABLE_HOURS: 24,       // 하루 최대 합리적 근무시간
      MIN_TIME_LENGTH: 5,
      MAX_TIME_LENGTH: 12,
      SEARCH_DEPTH: 3
    }
  };

  // 디버그 모드 (localStorage에서 제어)
  const DEBUG_MODE = localStorage.getItem('flex_extension_debug') === 'true';

  function debugLog(...args) {
    if (DEBUG_MODE) {
      console.log('[Flex 익스텐션]', ...args);
    }
  }

  // ============================================================
  // ERROR HANDLING LAYER - 에러 처리 및 사용자 피드백
  // ============================================================
  function displayError(message, isRetryable = true) {
    // 기존 에러 표시 제거
    const existingError = document.getElementById(CONFIG.UI.ERROR_DISPLAY_ID);
    if (existingError) {
      existingError.remove();
    }

    const errorElement = document.createElement('div');
    errorElement.id = CONFIG.UI.ERROR_DISPLAY_ID;
    errorElement.className = 'flex-extension-error';

    const errorHtml = `
      <div class="flex-error-container">
        <div class="flex-error-icon">⚠️</div>
        <div class="flex-error-content">
          <div class="flex-error-message">${message}</div>
          ${isRetryable ? '<button class="flex-error-retry">새로고침</button>' : ''}
        </div>
      </div>
    `;

    errorElement.innerHTML = errorHtml;

    // 새로고침 버튼 이벤트
    if (isRetryable) {
      const retryBtn = errorElement.querySelector('.flex-error-retry');
      retryBtn?.addEventListener('click', () => {
        errorElement.remove();
        isCalculated = false;
        calculateAndDisplayTotalTime();
      });
    }

    document.body.appendChild(errorElement);
    debugLog('에러 표시:', message);
  }

  function validateTimeData(todayMinutes, weekMinutes, startTime) {
    const errors = [];
    const warnings = [];

    // 시간 데이터 존재 확인 - 출근시간이 있으면 0시간도 허용
    if (todayMinutes === 0 && weekMinutes === 0 && !startTime) {
      errors.push('근무 시간 데이터가 없습니다.');
    }

    // 합리적인 범위 확인
    const totalHours = (todayMinutes + weekMinutes) / 60;
    if (totalHours > CONFIG.WORK_SCHEDULE.WEEKLY_TARGET_HOURS * 2) {
      warnings.push(`주간 근무시간이 ${Math.round(totalHours)}시간으로 매우 높습니다.`);
    }

    // 출근시간 형식 확인
    if (startTime && !/^\d{2}:\d{2}$/.test(startTime) && !/^익일 \d{2}:\d{2}$/.test(startTime)) {
      errors.push('출근시간 형식이 올바르지 않습니다.');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  // 시간 문자열을 분 단위로 변환
  function parseTimeToMinutes(timeStr) {
    if (!timeStr) return 0;

    // "9시간 47분" 형식 파싱
    const hourMinuteMatch = timeStr.match(/(\d+)시간\s*(\d+)분/);
    if (hourMinuteMatch) {
      const hours = parseInt(hourMinuteMatch[1], 10);
      const minutes = parseInt(hourMinuteMatch[2], 10);
      return hours * 60 + minutes;
    }

    // "23:20" 형식 파싱
    const colonMatch = timeStr.match(/(\d+):(\d+)/);
    if (colonMatch) {
      const hours = parseInt(colonMatch[1], 10);
      const minutes = parseInt(colonMatch[2], 10);
      return hours * 60 + minutes;
    }

    // "X시간" 형식 파싱
    const hoursOnlyMatch = timeStr.match(/(\d+)시간/);
    if (hoursOnlyMatch) {
      return parseInt(hoursOnlyMatch[1], 10) * 60;
    }

    return 0;
  }

  // 분을 "X시간 Y분" 형식으로 변환
  function formatMinutesToTime(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}시간 ${minutes.toString().padStart(2, '0')}분`;
  }

  // 분을 "HH:MM" 형식으로 변환
  function formatMinutesToClock(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }

  // "HH:MM" 형식의 시간에 분을 더해서 새로운 "HH:MM" 반환 (자정 넘으면 "익일" 표시)
  function addMinutesToTime(timeStr, minutesToAdd) {
    const [hours, minutes] = timeStr.split(':').map(num => parseInt(num, 10));
    const totalMinutes = hours * 60 + minutes + minutesToAdd;
    const newHours = Math.floor(totalMinutes / 60);
    const newMinutes = totalMinutes % 60;

    // 자정을 넘어가는 경우 "익일" 표시
    if (newHours >= 24) {
      const nextDayHours = newHours % 24;
      return `익일 ${nextDayHours.toString().padStart(2, '0')}:${newMinutes.toString().padStart(2, '0')}`;
    }

    return `${newHours.toString().padStart(2, '0')}:${newMinutes.toString().padStart(2, '0')}`;
  }

  // 출근시간 찾기 (개선된 버전: "휴게 없음" 주변에서 시간 찾기)
  function findStartTime() {
    try {
      const allElements = Array.from(document.querySelectorAll('*'));

      // 1. "휴게 없음" 또는 "기록 중" 요소 찾기
      let targetElement = null;

      // 먼저 "휴게 없음" 찾기
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        if (text === '휴게 없음' || (text.includes('휴게') && text.includes('없음') && text.length < 20)) {
          targetElement = el;
          debugLog('휴게 없음 요소 발견:', el.tagName, el.textContent.trim());
          break;
        }
      }

      // "휴게 없음"이 없으면 "기록 중" 찾기
      if (!targetElement) {
        for (const el of allElements) {
          const text = el.textContent?.trim() || '';
          if ((text === CONFIG.DOM_SELECTORS.RECORDING_TEXT || text.includes(CONFIG.DOM_SELECTORS.RECORDING_TEXT)) && text.length < 20) {
            targetElement = el;
            debugLog('기록 중 요소 발견:', el.tagName, el.textContent.trim());
            break;
          }
        }
      }

      if (!targetElement) {
        debugLog('휴게 없음 또는 기록 중 요소를 찾을 수 없습니다.');
        return null;
      }

      // 2. 타겟 요소 자체와 그 자식들에서만 시간 찾기
      const foundTimes = []; // 찾은 모든 시간 저장

      // 타겟 요소와 그 모든 하위 요소들을 검색
      const elementsToCheck = [targetElement, ...Array.from(targetElement.querySelectorAll('*'))];

      for (const el of elementsToCheck) {
        const elText = el.textContent?.trim() || '';
        if (elText.length > 30) continue;

        // "오전 X:XX" 또는 "오후 X:XX" 형식 찾기
        const timeMatch = elText.match(/^(오전|오후)\s*(\d{1,2}):(\d{2})$/);
        if (timeMatch) {
          const period = timeMatch[1];
          const hour = parseInt(timeMatch[2], 10);
          const minute = timeMatch[3];

          // 24시간 형식으로 변환
          let hour24 = hour;
          if (period === '오후' && hour !== 12) {
            hour24 = hour + 12;
          } else if (period === '오전' && hour === 12) {
            hour24 = 0;
          }

          const foundTime = `${hour24.toString().padStart(2, '0')}:${minute}`;
          foundTimes.push({
            time: foundTime,
            original: elText,
            hour24: hour24,
            minute: parseInt(minute, 10)
          });
          debugLog('시간 패턴 발견:', foundTime, '원본:', elText);
        }
      }

      if (foundTimes.length === 0) {
        debugLog('출근시간을 찾을 수 없습니다.');
        return null;
      }

      // 3. 가장 이른 시간 선택 (출근 시간 = 가장 이른 시간)
      foundTimes.sort((a, b) => {
        if (a.hour24 !== b.hour24) {
          return a.hour24 - b.hour24;
        }
        return a.minute - b.minute;
      });

      const startTime = foundTimes[0];
      debugLog('출근시간 확정 (가장 이른 시간):', startTime.time, '원본:', startTime.original);
      debugLog('찾은 모든 시간:', foundTimes.map(t => t.time).join(', '));

      return startTime.time;
    } catch (error) {
      debugLog('출근시간 찾기 오류:', error);
      return null;
    }
  }

  // 주간 총 근무시간 계산 및 표시
  function calculateAndDisplayTotalTime() {
    try {
      // 오늘 근무 중인 시간 찾기 (좌측 상단)
      // 방법 1: "근무중" 텍스트가 포함된 버튼 찾기
      let todayTimeText = null;
      const allButtons = document.querySelectorAll('button');

      for (const button of allButtons) {
        const buttonText = button.textContent?.trim() || '';
        if (buttonText.includes('근무중')) {
          // "근무중 56분" 형식에서 시간 추출
          const timeMatch = buttonText.match(/(\d+)시간\s*(\d+)분|(\d+)분/);
          if (timeMatch) {
            if (timeMatch[1] && timeMatch[2]) {
              // "X시간 Y분" 형식
              todayTimeText = `${timeMatch[1]}시간 ${timeMatch[2]}분`;
            } else if (timeMatch[3]) {
              // "X분" 형식
              todayTimeText = `0시간 ${timeMatch[3]}분`;
            }
            debugLog('오늘 근무시간 찾음 (근무중):', todayTimeText, '원본:', buttonText);
            break;
          }
        }
      }

      // 방법 2: 기존 셀렉터로 찾기 (폴백)
      if (!todayTimeText) {
        const todayTimeElement = document.querySelector(CONFIG.DOM_SELECTORS.TIME_ELEMENT);
        todayTimeText = todayTimeElement ? todayTimeElement.textContent.trim() : null;
        if (todayTimeText) {
          debugLog('오늘 근무시간 찾음 (셀렉터):', todayTimeText);
        }
      }

      // 이번 주 누적 시간 찾기 (우측 상단)
      // 방법 1: 버튼에서 찾기
      let weekTimeText = null;
      const buttons = document.querySelectorAll('button');

      for (const button of buttons) {
        const text = button.textContent.trim();
        // "23:20" 같은 형식을 찾되, "근무중"이 없고, 시간 형식인 것
        const match = text.match(/(\d+):(\d+)/);
        if (match && !text.includes('근무중') && !text.includes('시간')) {
          weekTimeText = match[0]; // "23:20"
          debugLog('누적 시간 찾음 (버튼):', weekTimeText, '전체 텍스트:', text);
          break;
        }
      }

      // 방법 2: 버튼에서 못 찾으면 모든 요소에서 찾기
      if (!weekTimeText) {
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const text = el.textContent.trim();
          // 짧은 텍스트에서 시간 패턴만 있는 경우
          if (text.length < 30 && text.match(/^\d+:\d+$/) && !text.includes('근무중')) {
            weekTimeText = text;
            debugLog('누적 시간 찾음 (전체 검색):', weekTimeText);
            break;
          }
        }
      }

      if (!todayTimeText && !weekTimeText) {
        debugLog('시간 데이터를 찾을 수 없습니다.');
        displayError('근무 시간 데이터를 찾을 수 없습니다. 페이지를 새로고침해주세요.');
        return;
      }

      // 시간을 분으로 변환
      const todayMinutes = parseTimeToMinutes(todayTimeText || '0');
      const weekMinutes = parseTimeToMinutes(weekTimeText || '0');
      const totalMinutes = todayMinutes + weekMinutes;

      // 출근시간 찾기
      const startTime = findStartTime();

      // 데이터 검증
      const validation = validateTimeData(todayMinutes, weekMinutes, startTime);
      if (!validation.valid) {
        debugLog('검증 실패:', validation.errors);
        displayError(validation.errors.join(', '));
        return;
      }

      // 경고사항 로그
      if (validation.warnings.length > 0) {
        debugLog('경고:', validation.warnings);
      }

      // 예상 퇴근시간 계산
      let expectedEndTime = null;
      if (startTime) {
        const today = new Date();
        const dayOfWeek = today.getDay(); // 0(일) ~ 6(토)

        if (CONFIG.WORK_SCHEDULE.REGULAR_WORK_DAYS.includes(dayOfWeek)) {
          // 월~목: 8시간 + 1시간 점심 = 9시간 후 퇴근
          const dailyWorkMinutes = CONFIG.WORK_SCHEDULE.DAILY_WORK_HOURS * 60;
          const minutesUntilEnd = dailyWorkMinutes + CONFIG.WORK_SCHEDULE.LUNCH_BREAK_MINUTES;
          expectedEndTime = addMinutesToTime(startTime, minutesUntilEnd);
        } else if (dayOfWeek === CONFIG.WORK_SCHEDULE.FLEX_DAY) {
          // 금요일: 남은 시간 기준 계산
          const weeklyTargetMinutes = CONFIG.WORK_SCHEDULE.WEEKLY_TARGET_HOURS * 60;
          const totalWorkedMinutes = weekMinutes + todayMinutes; // 이번 주 총 근무
          const remainingMinutes = weeklyTargetMinutes - totalWorkedMinutes; // 남은 근무시간

          if (remainingMinutes > 0) {
            // 아직 40시간 미달: 출근시간 + 남은 시간 + 점심
            // todayMinutes는 이미 totalWorkedMinutes에 포함되어 있으므로 제외
            const minutesUntilEnd = remainingMinutes + CONFIG.WORK_SCHEDULE.LUNCH_BREAK_MINUTES;
            expectedEndTime = addMinutesToTime(startTime, minutesUntilEnd);
          } else if (remainingMinutes === 0) {
            // 정확히 40시간 달성
            expectedEndTime = "정시 퇴근 가능";
          } else {
            // 이미 40시간 초과: 초과근무 시간 표시
            const overtimeMinutes = Math.abs(remainingMinutes);
            expectedEndTime = `초과근무 중 (${formatMinutesToTime(overtimeMinutes)} 초과)`;
          }
        }
        // 주말(토,일)은 예상 퇴근시간 표시 안 함
      }

      // 결과 포맷
      const totalTimeFormatted = formatMinutesToTime(totalMinutes);

      debugLog('계산 완료:', {
        오늘: todayTimeText,
        이번주누적: weekTimeText,
        총합: totalTimeFormatted,
        출근시간: startTime,
        예상퇴근: expectedEndTime
      });

      // UI 표시
      displayTotalTime(totalTimeFormatted, todayMinutes, weekMinutes, startTime, expectedEndTime);
    } catch (error) {
      debugLog('계산 중 오류 발생:', error);
      displayError('시간 계산 중 오류가 발생했습니다. 페이지를 새로고침해주세요.');
    }
  }

  // 총 근무시간을 페이지에 표시
  function displayTotalTime(totalTime, todayMinutes, weekMinutes, startTime, expectedEndTime) {
    try {
      // 기존 표시 제거
      const existingDisplay = document.getElementById(CONFIG.UI.DISPLAY_ID);
      if (existingDisplay) {
        existingDisplay.remove();
      }

      // 기존 에러 표시 제거
      const existingError = document.getElementById(CONFIG.UI.ERROR_DISPLAY_ID);
      if (existingError) {
        existingError.remove();
      }

      // 총 근무시간 표시 요소 생성
      const displayElement = document.createElement('div');
      displayElement.id = CONFIG.UI.DISPLAY_ID;
      displayElement.className = 'flex-extension-display';

    // 예상 퇴근시간 HTML 생성 (있는 경우에만)
    const endTimeHtml = (startTime && expectedEndTime) ? `
      <div class="flex-end-time">
        <div class="flex-end-time-label">예상 퇴근시간</div>
        <div class="flex-end-time-value">${expectedEndTime}</div>
        <div class="flex-start-time">(출근: ${startTime})</div>
      </div>
    ` : '';

    displayElement.innerHTML = `
      <div class="flex-total-container">
        <button class="flex-toggle-btn" aria-label="근무시간 정보 토글">▼</button>
        <div class="flex-content">
          <div class="flex-total-label">이번 주 총 근무시간</div>
          <div class="flex-total-time">${totalTime}</div>
          <div class="flex-total-breakdown">
            <span class="flex-breakdown-item">누적: ${formatMinutesToTime(weekMinutes)}</span>
            <span class="flex-breakdown-separator">+</span>
            <span class="flex-breakdown-item">오늘: ${formatMinutesToTime(todayMinutes)}</span>
          </div>
          ${endTimeHtml}
        </div>
      </div>
    `;

    // 토글 버튼 이벤트 추가
    const toggleBtn = displayElement.querySelector('.flex-toggle-btn');
    const content = displayElement.querySelector('.flex-content');

    toggleBtn.addEventListener('click', () => {
      const isHidden = content.style.display === 'none';
      content.style.display = isHidden ? 'flex' : 'none';
      toggleBtn.textContent = isHidden ? '▼' : '▶';
      toggleBtn.setAttribute('aria-expanded', isHidden);
    });

    // 오른쪽 상단 고정 위치이므로 body에 추가
    document.body.appendChild(displayElement);
    debugLog('오른쪽 상단에 표시');
  } catch (error) {
    debugLog('표시 중 오류 발생:', error);
    displayError('화면 표시 중 오류가 발생했습니다.');
  }
}

  // 페이지 로드 시 한 번만 실행
  let isCalculated = false;

  function initialize() {
    try {
      const tryCalculate = () => {
        if (!isCalculated && !document.getElementById(CONFIG.UI.DISPLAY_ID)) {
          calculateAndDisplayTotalTime();
          isCalculated = true;
          return true;
        }
        return false;
      };

      // 3.5초 딜레이 후 실행 시작
      debugLog('3.5초 후 실행 예정...');
      setTimeout(() => {
        // 첫 시도
        if (tryCalculate()) {
          debugLog('딜레이 후 실행 성공');
          return;
        }

        // 실패 시 MutationObserver 시작
        debugLog('첫 시도 실패, MutationObserver 시작');

        let retryCount = 0;
        const observer = new MutationObserver((mutations, obs) => {
          retryCount++;

          if (tryCalculate()) {
            debugLog('MutationObserver 감지 후 실행 성공');
            obs.disconnect();
            return;
          }

          // 최대 재시도 횟수 도달
          if (retryCount >= CONFIG.TIMING.MAX_RETRIES) {
            debugLog('최대 재시도 횟수 도달');
            obs.disconnect();
          }
        });

        // DOM 변화 감지 시작
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });

        // 타임아웃 설정 (안전장치)
        setTimeout(() => {
          observer.disconnect();
          if (!isCalculated) {
            debugLog('타임아웃 후 마지막 시도');
            tryCalculate();
          }
        }, CONFIG.TIMING.OBSERVER_TIMEOUT);

        // 추가 폴백: 일정 간격으로 재시도
        let fallbackRetries = 0;
        const fallbackInterval = setInterval(() => {
          fallbackRetries++;

          if (tryCalculate() || fallbackRetries >= 5) {
            clearInterval(fallbackInterval);
            if (fallbackRetries >= 5) {
              debugLog('폴백 재시도 최대 횟수 도달');
            }
          }
        }, CONFIG.TIMING.RETRY_INTERVAL);
      }, 3500);

    } catch (error) {
      debugLog('초기화 중 오류 발생:', error);
      displayError('익스텐션 초기화 중 오류가 발생했습니다.');
    }
  }

  // 페이지 로드 완료 시 실행
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();
